// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {PactSuite} from "./utils/PactSuite.sol";
import {ReentrantUSDT} from "./mocks/ReentrantUSDT.sol";

/// @notice v3 subscriptions: packed storage, all-or-nothing two-transfer renewals, keeper batches and
/// subscribing with a permit.
contract SubscriptionV3Test is PactSuite {
    uint256 constant FEE = 150_000;
    uint256 constant START = 1_800_000_000;

    function setUp() public {
        vm.warp(START);
        _deploy();
        token.mint(merchant, 100_000_000);
        token.mint(payer, 100_000_000);
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
    }

    function _mandate(uint256 nonce) internal view returns (SubscriptionManagerV2.Mandate memory) {
        return SubscriptionManagerV2.Mandate(
            payer, merchant, keccak256("monthly"), 2_000_000, 1 days, 12, uint64(START + 30 days), nonce
        );
    }

    function _register() internal returns (bytes32) {
        SubscriptionManagerV2.Mandate memory m = _mandate(subs.nonces(payer));
        return subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
    }

    function _expectRefusal(bytes32 id, SubscriptionManagerV2.Refusal reason) internal {
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManagerV2.Refused(id, reason);
    }

    function testTheSubscriptionViewReturnsEveryField() public {
        bytes32 id = _register();
        SubscriptionManagerV2.SubscriptionView memory s = subs.subscription(id);
        assertEq(s.payer, payer);
        assertEq(s.merchant, merchant);
        assertEq(s.planId, keccak256("monthly"));
        assertEq(s.amountCap, 2_000_000);
        assertEq(s.periodSeconds, 1 days);
        assertEq(s.maxPeriods, 12);
        assertEq(s.chargedPeriods, 0);
        assertEq(s.endTime, START + 30 days);
        assertEq(s.nextChargeAt, START);
        assertFalse(s.cancelled);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        s = subs.subscription(id);
        assertEq(s.chargedPeriods, 1);
        assertEq(s.nextChargeAt, START + 1 days);
    }

    function testAnOversizedCapIsRefused() public {
        SubscriptionManagerV2.Mandate memory m = _mandate(0);
        m.amountCap = uint256(type(uint128).max) + 1;
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        subs.subscribe(m, signature);
    }

    function testARenewalIsAllOrNothing() public {
        bytes32 id = _register();
        // The fee transfer fails after the merchant's would have succeeded: nothing at all moves.
        token.setBlocked(relayer, true);
        _expectRefusal(id, SubscriptionManagerV2.Refusal.TransferFailed);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), 100_000_000);
        assertEq(token.balanceOf(merchant), 100_000_000);
        assertEq(subs.subscription(id).chargedPeriods, 0);
        assertEq(subs.subscription(id).nextChargeAt, START);
        token.setBlocked(relayer, false);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManagerV2.Charged(id, 2_000_000, 1, FEE, uint64(START + 1 days), relayer);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(merchant), 100_000_000 + 2_000_000 - FEE);
        assertEq(token.balanceOf(relayer), FEE);
    }

    function testOnlyTheContractRunsTheSettlementStep() public {
        bytes32 id = _register();
        vm.expectRevert(SubscriptionManagerV2.NotAuthorized.selector);
        vm.prank(keeper);
        subs.settleRenewal(id, payer, other, 2_000_000, other, 0, 1, uint64(START + 1 days));
        assertEq(token.balanceOf(payer), 100_000_000);
    }

    function testChargeBatchRenewsManyAndIsolatesEachFailure() public {
        bytes32 a = _register();
        bytes32 b = _register();
        bytes32 c = _register();
        bytes32 d = _register();
        vm.prank(payer);
        subs.cancel(b);
        bytes32[] memory ids = new bytes32[](5);
        uint256[] memory amounts = new uint256[](5);
        (ids[0], ids[1], ids[2], ids[3], ids[4]) = (a, b, keccak256("missing"), c, d);
        (amounts[0], amounts[1], amounts[2], amounts[3], amounts[4]) =
            (2_000_000, 2_000_000, 2_000_000, 2_000_001, 1_000_000);
        _expectRefusal(b, SubscriptionManagerV2.Refusal.Cancelled);
        _expectRefusal(keccak256("missing"), SubscriptionManagerV2.Refusal.UnknownSubscription);
        _expectRefusal(c, SubscriptionManagerV2.Refusal.CapExceeded);
        vm.prank(keeper);
        bool[] memory charged = subs.chargeBatch(ids, amounts);
        assertTrue(charged[0]);
        assertFalse(charged[1]);
        assertFalse(charged[2]);
        assertFalse(charged[3]);
        assertTrue(charged[4]);
        assertEq(token.balanceOf(payer), 100_000_000 - 3_000_000);
        assertEq(token.balanceOf(relayer), 2 * FEE);
        assertEq(subs.subscription(a).chargedPeriods, 1);
        assertEq(subs.subscription(c).chargedPeriods, 0);
        // A second run the same day: every one is too early or refused, and the batch still completes.
        vm.prank(keeper);
        charged = subs.chargeBatch(ids, amounts);
        for (uint256 i; i < charged.length; ++i) assertFalse(charged[i]);
    }

    function testABatchFromAnyoneElseIsRefusedItemByItemNotReverted() public {
        bytes32 a = _register();
        bytes32[] memory ids = new bytes32[](1);
        uint256[] memory amounts = new uint256[](1);
        (ids[0], amounts[0]) = (a, 2_000_000);
        _expectRefusal(a, SubscriptionManagerV2.Refusal.NotAuthorized);
        vm.prank(other);
        bool[] memory charged = subs.chargeBatch(ids, amounts);
        assertFalse(charged[0]);
        assertEq(token.balanceOf(payer), 100_000_000);
        // The merchant itself may renew its own subscriptions in a batch.
        vm.prank(merchant);
        charged = subs.chargeBatch(ids, amounts);
        assertTrue(charged[0]);
    }

    function testABatchWithAFailingTokenTransferKeepsTheOthers() public {
        bytes32 a = _register();
        bytes32 b = _register();
        bytes32[] memory ids = new bytes32[](2);
        uint256[] memory amounts = new uint256[](2);
        (ids[0], ids[1]) = (a, b);
        (amounts[0], amounts[1]) = (2_000_000, 2_000_000);
        // The payer's allowance covers exactly one renewal: the second pull fails its balance check.
        vm.prank(payer);
        token.approve(address(subs), 2_000_000);
        _expectRefusal(b, SubscriptionManagerV2.Refusal.InsufficientFunds);
        vm.prank(keeper);
        bool[] memory charged = subs.chargeBatch(ids, amounts);
        assertTrue(charged[0]);
        assertFalse(charged[1]);
        assertEq(token.balanceOf(payer), 98_000_000);
    }

    function testMismatchedBatchArraysRevert() public {
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        vm.prank(keeper);
        subs.chargeBatch(new bytes32[](2), new uint256[](1));
    }

    function testSubscribeWithPermitSetsTheAllowanceInTheSameTransaction() public {
        vm.prank(payer);
        token.approve(address(subs), 0);
        SubscriptionManagerV2.Mandate memory m = _mandate(0);
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(_erc2612(PAYER_KEY, address(subs), 24_000_000), (uint256, uint256, uint8, bytes32, bytes32));
        vm.prank(relayer);
        bytes32 id = subs.subscribeWithPermit(m, signature, value, deadline, v, r, s);
        assertEq(token.allowance(payer, address(subs)), 24_000_000);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        assertEq(token.allowance(payer, address(subs)), 22_000_000);
    }

    function testAFrontRunPermitDoesNotBlockSubscribing() public {
        SubscriptionManagerV2.Mandate memory m = _mandate(0);
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(_erc2612(PAYER_KEY, address(subs), 24_000_000), (uint256, uint256, uint8, bytes32, bytes32));
        vm.prank(other);
        token.permit(payer, address(subs), value, deadline, v, r, s);
        vm.prank(relayer);
        bytes32 id = subs.subscribeWithPermit(m, signature, value, deadline, v, r, s);
        assertEq(subs.subscription(id).payer, payer);
        // A bad mandate signature still refuses the registration, permit or not.
        SubscriptionManagerV2.Mandate memory next = _mandate(1);
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribeWithPermit(next, signature, value, deadline, v, r, s);
    }

    function testAHostileTokenCannotReenterARenewal() public {
        ReentrantUSDT hostile = new ReentrantUSDT();
        (FeeSchedule f,,, SubscriptionManagerV2 s) =
            _deploySuite(IERC20(address(hostile)), relayer, keeper, USDT_PER_WBT, CANONICAL_PERMIT2);
        uint32 version = f.latestVersion();
        uint256 deadline = block.timestamp + 1 hours;
        f.acceptWithSig(merchant, version, deadline, _sign(MERCHANT_KEY, f.hashAcceptance(merchant, version, 0, deadline)));
        hostile.mint(payer, 100_000_000);
        vm.prank(payer);
        hostile.approve(address(s), type(uint256).max);
        SubscriptionManagerV2.Mandate memory m = _mandate(0);
        bytes32 id = s.subscribe(m, _sign(PAYER_KEY, s.hashMandate(m)));
        // During the renewal's transfer the token tries to renew again.
        hostile.arm(address(s), abi.encodeCall(s.charge, (id, 2_000_000)));
        vm.prank(keeper);
        assertTrue(s.charge(id, 2_000_000));
        assertTrue(hostile.attempted());
        assertFalse(hostile.reentered());
        assertEq(bytes4(hostile.reentryResult()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        // ...or to run the settlement step itself.
        vm.warp(START + 1 days);
        hostile.arm(
            address(s), abi.encodeCall(s.settleRenewal, (id, payer, other, 1_000_000, other, 0, 9, uint64(START)))
        );
        vm.prank(keeper);
        assertTrue(s.charge(id, 2_000_000));
        assertFalse(hostile.reentered());
        assertEq(bytes4(hostile.reentryResult()), SubscriptionManagerV2.NotAuthorized.selector);
        assertEq(hostile.balanceOf(payer), 96_000_000);
        assertEq(hostile.balanceOf(other), 0);
        assertEq(s.subscription(id).chargedPeriods, 2);
    }

    function testFuzzABatchChargesExactlyWhatSingleChargesWould(uint8 count, uint8 failMask) public {
        uint256 n = bound(count, 1, 8);
        bytes32[] memory ids = new bytes32[](n);
        uint256[] memory amounts = new uint256[](n);
        uint256 expected;
        for (uint256 i; i < n; ++i) {
            ids[i] = _register();
            bool fail = (failMask >> i) & 1 == 1;
            amounts[i] = fail ? 2_000_001 : 2_000_000;
            if (!fail) expected += 2_000_000;
        }
        vm.prank(keeper);
        subs.chargeBatch(ids, amounts);
        assertEq(token.balanceOf(payer), 100_000_000 - expected);
        assertEq(token.balanceOf(relayer), (expected / 2_000_000) * FEE);
    }
}
