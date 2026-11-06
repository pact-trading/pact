// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IFeeSchedule} from "../src/FeeSchedule.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {Router} from "../src/Router.sol";
import {PactSuite} from "./utils/PactSuite.sol";

contract SubscriptionV2Test is PactSuite {
    uint256 constant FEE = 150_000; // 0.8% of 2 USDT is below the 0.15 USDT floor.

    function setUp() public {
        vm.warp(1_800_000_000);
        _deploy();
        token.mint(merchant, 100_000_000);
        token.mint(payer, 100_000_000);
        vm.prank(payer);
        token.approve(address(subs), 100_000_000);
    }

    function mandate(uint256 nonce) internal view returns (SubscriptionManagerV2.Mandate memory) {
        return SubscriptionManagerV2.Mandate(
            payer, merchant, keccak256("monthly"), 2_000_000, 1 days, 12, uint64(block.timestamp + 30 days), nonce
        );
    }

    function register() internal returns (bytes32) {
        SubscriptionManagerV2.Mandate memory m = mandate(subs.nonces(payer));
        return subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
    }

    function cancelled(bytes32 id) internal view returns (bool) {
        return subs.subscription(id).cancelled;
    }

    function execute(bytes memory data, uint256 nonce, uint256 key) internal returns (bool ok) {
        Router.Intent memory i = Router.Intent(
            vm.addr(key),
            merchant,
            address(subs),
            keccak256(data),
            2_000_000,
            nonce,
            uint64(block.timestamp + 1 hours),
            500_000
        );
        bytes memory signature = _sign(key, router.hashIntent(i));
        vm.prank(relayer);
        (ok,) = router.execute(i, data, signature);
    }

    function expectRefusal(bytes32 id, SubscriptionManagerV2.Refusal reason) internal {
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManagerV2.Refused(id, reason);
    }

    function testSponsoredRegistrationIsFreeAndEachRenewalPaysTheMerchantLessTheFee() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        assertTrue(execute(abi.encodeCall(subs.subscribe, (m, _sign(PAYER_KEY, subs.hashMandate(m)))), 1, PAYER_KEY));
        assertEq(subs.nonces(payer), 1);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(token.balanceOf(merchant), 100_000_000);
        bytes32 id = keccak256(abi.encode(payer, uint256(0), address(subs)));
        uint256 beforePayer = token.balanceOf(payer);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManagerV2.Charged(id, 2_000_000, 1, FEE, uint64(block.timestamp + 1 days), relayer);
        assertTrue(execute(abi.encodeCall(subs.charge, (id, 2_000_000)), 1, MERCHANT_KEY));
        assertEq(token.balanceOf(payer), beforePayer - 2_000_000);
        assertEq(token.balanceOf(merchant), 100_000_000 + 2_000_000 - FEE);
        assertEq(token.balanceOf(relayer), FEE);
        assertEq(token.balanceOf(address(subs)), 0);
        assertEq(payer.balance, 0);
        // Too early for the next period: refused, and nothing moves.
        assertFalse(execute(abi.encodeCall(subs.charge, (id, 2_000_000)), 2, MERCHANT_KEY));
        assertEq(token.balanceOf(relayer), FEE);
    }

    function testTheKeeperRenewalPaysTheFeeToo() public {
        bytes32 id = register();
        vm.expectRevert(SubscriptionManagerV2.NotAuthorized.selector);
        vm.prank(other);
        subs.charge(id, 2_000_000);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(merchant), 100_000_000 + 2_000_000 - FEE);
        assertEq(token.balanceOf(relayer), FEE);
    }

    function testRenewalForAMerchantWithoutTermsIsRefusedNotCharged() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        m.merchant = address(0xD00D);
        bytes32 id = subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
        expectRefusal(id, SubscriptionManagerV2.Refusal.FeeUnavailable);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), 100_000_000);
    }

    function testRenewalRefusalReasons() public {
        // Absolute times: via-IR may reuse an earlier TIMESTAMP read across warps.
        uint256 start = block.timestamp;
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        m.maxPeriods = 2;
        m.endTime = uint64(start + 4 days);
        bytes32 id = subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
        expectRefusal(id, SubscriptionManagerV2.Refusal.CapExceeded);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_001));
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        expectRefusal(id, SubscriptionManagerV2.Refusal.TooEarly);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        vm.prank(payer);
        token.approve(address(subs), 0);
        vm.warp(start + 1 days);
        expectRefusal(id, SubscriptionManagerV2.Refusal.InsufficientFunds);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
        token.setFailTransfers(true);
        expectRefusal(id, SubscriptionManagerV2.Refusal.TransferFailed);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        token.setFailTransfers(false);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        vm.warp(start + 2 days);
        expectRefusal(id, SubscriptionManagerV2.Refusal.MaxPeriods);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        vm.warp(start + 5 days);
        expectRefusal(id, SubscriptionManagerV2.Refusal.Expired);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        vm.prank(payer);
        subs.cancel(id);
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        vm.prank(payer);
        subs.cancel(id);
        expectRefusal(id, SubscriptionManagerV2.Refusal.Cancelled);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(relayer), 2 * FEE);
    }

    function testFreeSponsoredCancellation() public {
        bytes32 id = register();
        bytes memory data = abi.encodeCall(subs.cancel, (id));
        assertTrue(execute(data, 7, PAYER_KEY));
        assertTrue(cancelled(id));
        assertEq(token.balanceOf(relayer), 0);
        assertEq(token.balanceOf(payer), 100_000_000);
    }

    function testThePayerSignatureIsRequiredAndUsedOnce() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory wrong = _sign(MERCHANT_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribe(m, wrong);
        assertEq(subs.nonces(payer), 0);
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        subs.subscribe(m, signature);
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        subs.subscribe(m, signature);
        // The next mandate needs its own signature.
        SubscriptionManagerV2.Mandate memory next = mandate(1);
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribe(next, signature);
    }

    function testFuzzPayerSignatureBindsEveryMandateField(uint8 field) public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        uint8 index = field % 7;
        if (index == 0) m.merchant = address(0x5678);
        if (index == 1) m.planId = keccak256("changed");
        if (index == 2) m.amountCap++;
        if (index == 3) m.periodSeconds++;
        if (index == 4) m.maxPeriods++;
        if (index == 5) m.endTime++;
        if (index == 6) m.payer = address(0x1234);
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribe(m, signature);
        assertEq(subs.nonces(payer), 0);
    }

    function testMandateCannotCrossContractOrChain() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        SubscriptionManagerV2 second =
            new SubscriptionManagerV2(IERC20(address(token)), address(router), keeper, IFeeSchedule(address(fees)));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        second.subscribe(m, signature);
        vm.chainId(block.chainid + 1);
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribe(m, signature);
    }

    function testReplaceIsAtomicAndKeepsPayerAndMerchant() public {
        bytes32 id = register();
        SubscriptionManagerV2.Mandate memory m = mandate(1);
        bytes memory p = _sign(PAYER_KEY, subs.hashMandate(m));
        // Only the payer replaces, and the new mandate keeps the same merchant.
        vm.expectRevert(SubscriptionManagerV2.NotAuthorized.selector);
        vm.prank(other);
        subs.replace(id, m, p);
        SubscriptionManagerV2.Mandate memory elsewhere = mandate(1);
        elsewhere.merchant = other;
        bytes memory elsewhereSignature = _sign(PAYER_KEY, subs.hashMandate(elsewhere));
        vm.expectRevert(SubscriptionManagerV2.NotAuthorized.selector);
        vm.prank(payer);
        subs.replace(id, elsewhere, elsewhereSignature);
        // A bad new mandate leaves the old subscription untouched.
        bytes memory wrong = _sign(MERCHANT_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        vm.prank(payer);
        subs.replace(id, m, wrong);
        assertFalse(cancelled(id));
        assertEq(subs.nonces(payer), 1);
        vm.prank(payer);
        bytes32 replacement = subs.replace(id, m, p);
        assertTrue(cancelled(id));
        assertFalse(cancelled(replacement));
        assertEq(subs.nonces(payer), 2);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
    }

    function testSignedCancellationNeedsNoGasOrFeeFromAnyone() public {
        bytes32 id = register();
        assertEq(payer.balance, 0);
        uint256 balance = token.balanceOf(payer);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(PAYER_KEY, subs.hashCancellation(id, deadline));
        vm.prank(relayer);
        subs.cancelWithSignature(id, deadline, signature);
        assertTrue(cancelled(id));
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), balance);
        assertEq(token.balanceOf(relayer), 0);
        assertEq(payer.balance, 0);
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        subs.cancelWithSignature(id, deadline, signature);
    }

    function testCancellationRejectsWrongSignerExpiredAndAlteredAuthorization() public {
        bytes32 id = register();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(MERCHANT_KEY, subs.hashCancellation(id, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(id, deadline, signature);
        signature = _sign(PAYER_KEY, subs.hashCancellation(id, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(id, deadline + 1, signature);
        vm.warp(deadline + 1);
        vm.expectRevert(SubscriptionManagerV2.ExpiredCancellation.selector);
        subs.cancelWithSignature(id, deadline, signature);
        assertFalse(cancelled(id));
    }

    function testRenewalLimitsStillApply() public {
        uint256 start = block.timestamp;
        bytes32 id = register();
        vm.startPrank(keeper);
        assertFalse(subs.charge(id, 2_000_001));
        assertTrue(subs.charge(id, 2_000_000));
        assertFalse(subs.charge(id, 2_000_000));
        vm.warp(start + 1 days);
        assertTrue(subs.charge(id, 2_000_000));
        vm.warp(start + 32 days);
        assertFalse(subs.charge(id, 2_000_000));
        vm.stopPrank();
        assertEq(token.balanceOf(payer), 96_000_000);
    }

    function testCancellationCannotCrossSubscriptionOrDomain() public {
        vm.chainId(1874);
        bytes32 first = register();
        bytes32 second = register();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = _sign(PAYER_KEY, subs.hashCancellation(first, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(second, deadline, signature);
        // Explicit constants avoid optimizer assumptions that CHAINID stays
        // invariant across the test's deliberate chainId mutation.
        vm.chainId(1875);
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(first, deadline, signature);
        vm.chainId(1874);
        // The deadline is inclusive, matching Router's deadline semantics.
        vm.warp(deadline);
        subs.cancelWithSignature(first, deadline, signature);
        assertTrue(cancelled(first));
        assertFalse(cancelled(second));
    }

    function testMissingTokenAllowanceAndMaxPeriodsDoNotChargeExtra() public {
        uint256 start = block.timestamp;
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        m.maxPeriods = 1;
        bytes32 id = subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
        vm.prank(payer);
        token.approve(address(subs), 0);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        vm.prank(payer);
        token.approve(address(subs), 4_000_000);
        vm.prank(keeper);
        assertTrue(subs.charge(id, 2_000_000));
        vm.warp(start + 1 days);
        vm.prank(keeper);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), 98_000_000);
        assertEq(token.allowance(payer, address(subs)), 2_000_000);
    }
}
