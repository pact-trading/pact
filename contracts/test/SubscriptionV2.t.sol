// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {GasTank} from "../src/GasTank.sol";
import {Router} from "../src/Router.sol";
import {MockNoBoolUSDT} from "./mocks/MockNoBoolUSDT.sol";

contract SubscriptionV2Test is Test {
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;
    address payer;
    address merchant;
    MockNoBoolUSDT token;
    GasTank tank;
    Router router;
    SubscriptionManagerV2 subs;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(PAYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        token = new MockNoBoolUSDT();
        tank = new GasTank();
        router = new Router(IERC20(address(token)), tank, address(this));
        tank.setRouter(address(router));
        subs = new SubscriptionManagerV2(IERC20(address(token)), address(router), address(this));
        router.setAllowed(address(subs), subs.subscribe.selector, true, false);
        router.setAllowed(address(subs), subs.replace.selector, true, false);
        router.setAllowed(address(subs), subs.charge.selector, true, true);
        token.mint(merchant, 100_000_000);
        token.mint(payer, 100_000_000);
        vm.prank(merchant);
        token.approve(address(router), 1_000_000);
        vm.prank(payer);
        token.approve(address(subs), 100_000_000);
        vm.txGasPrice(1 gwei);
    }

    function mandate(uint256 nonce) internal view returns (SubscriptionManagerV2.Mandate memory) {
        return SubscriptionManagerV2.Mandate(
            payer, merchant, keccak256("monthly"), 2_000_000, 1 days, 12, uint64(block.timestamp + 30 days), nonce
        );
    }

    function sign(uint256 key, bytes32 hash) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, hash);
        return abi.encodePacked(r, s, v);
    }

    function register() internal returns (bytes32) {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        return subs.subscribe(
            m, sign(PAYER_KEY, subs.hashMandate(m)), m.endTime, sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime))
        );
    }

    function cancelled(bytes32 id) internal view returns (bool) {
        (,,,,,,,,, bool value) = subs.subscriptions(id);
        return value;
    }

    function fundTank() internal {
        vm.deal(merchant, 1 ether);
        vm.startPrank(merchant);
        tank.deposit{value: 0.5 ether}(merchant);
        tank.setDailyCap(0.5 ether);
        vm.stopPrank();
    }

    function execute(bytes memory data, uint256 nonce, uint256 key) internal returns (bool ok) {
        Router.Intent memory i = Router.Intent(
            vm.addr(key),
            merchant,
            address(subs),
            keccak256(data),
            2_000_000,
            10_000,
            nonce,
            uint64(block.timestamp + 1 hours),
            500_000
        );
        (ok,) = router.execute(i, data, sign(key, router.hashIntent(i)));
    }

    function testMerchantConsentIsRequiredForDirectAndSponsoredRegistration() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory payerSignature = sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, payerSignature, m.endTime, "");
        fundTank();
        uint256 balance = tank.balanceOf(merchant);
        uint256 allowance = token.allowance(merchant, address(router));
        assertFalse(execute(abi.encodeCall(subs.subscribe, (m, payerSignature, m.endTime, bytes(""))), 1, PAYER_KEY));
        assertEq(tank.balanceOf(merchant), balance);
        assertEq(token.allowance(merchant, address(router)), allowance);
        assertEq(subs.nonces(payer), 0);
        assertFalse(router.usedNonces(payer, 1));
    }

    function testApprovedSponsoredRegistrationAndMerchantRenewalPayFees() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        fundTank();
        uint256 beforeTank = tank.balanceOf(merchant);
        assertTrue(
            execute(
                abi.encodeCall(
                    subs.subscribe,
                    (
                        m,
                        sign(PAYER_KEY, subs.hashMandate(m)),
                        m.endTime,
                        sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime))
                    )
                ),
                1,
                PAYER_KEY
            )
        );
        assertEq(subs.nonces(payer), 1);
        assertLt(tank.balanceOf(merchant), beforeTank);
        assertEq(token.allowance(merchant, address(router)), 990_000);
        bytes32 id = keccak256(abi.encode(payer, uint256(0), address(subs)));
        uint256 beforePayer = token.balanceOf(payer);
        beforeTank = tank.balanceOf(merchant);
        assertTrue(execute(abi.encodeCall(subs.charge, (id, 2_000_000)), 1, MERCHANT_KEY));
        assertEq(token.balanceOf(payer), beforePayer - 2_000_000);
        assertLt(tank.balanceOf(merchant), beforeTank);
        assertEq(token.allowance(merchant, address(router)), 980_000);
        assertEq(payer.balance, 0);
        assertFalse(execute(abi.encodeCall(subs.charge, (id, 2_000_000)), 2, MERCHANT_KEY));
        assertEq(token.allowance(merchant, address(router)), 980_000);
    }

    function testConsentExpiryRevocationAndReplay() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory p = sign(PAYER_KEY, subs.hashMandate(m));
        uint64 deadline = uint64(block.timestamp - 1);
        bytes memory c = sign(MERCHANT_KEY, subs.hashConsent(m, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, p, deadline, c);
        deadline = m.endTime + 1;
        c = sign(MERCHANT_KEY, subs.hashConsent(m, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, p, deadline, c);
        c = sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime));
        bytes32 hash = subs.hashMandate(m);
        vm.prank(merchant);
        subs.revokeConsent(hash);
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, p, m.endTime, c);
        assertEq(subs.nonces(payer), 0);
        // Revoking the same digest as another address cannot revoke this merchant's consent.
        m.planId = keccak256("another approved plan");
        p = sign(PAYER_KEY, subs.hashMandate(m));
        c = sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime));
        subs.revokeConsent(subs.hashMandate(m));
        subs.subscribe(m, p, m.endTime, c);
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        subs.subscribe(m, p, m.endTime, c);
    }

    function testFuzzConsentBindsEveryMandateField(uint8 field) public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory consent = sign(MERCHANT_KEY, subs.hashConsent(m, deadline));
        uint8 index = field % 8;
        if (index == 0) m.payer = address(0x1234);
        if (index == 1) m.merchant = address(0x5678);
        if (index == 2) m.planId = keccak256("changed");
        if (index == 3) m.amountCap++;
        if (index == 4) m.periodSeconds++;
        if (index == 5) m.maxPeriods++;
        if (index == 6) m.endTime++;
        if (index == 7) m.nonce++;
        bytes memory payerSignature = sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, payerSignature, deadline, consent);
        assertEq(subs.nonces(payer), 0);
    }

    function testConsentCannotCrossChainContractOrDeadline() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory consent = sign(MERCHANT_KEY, subs.hashConsent(m, deadline));
        bytes memory p = sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, p, deadline + 1, consent);
        SubscriptionManagerV2 other = new SubscriptionManagerV2(IERC20(address(token)), address(router), address(this));
        bytes memory otherPayerSignature = sign(PAYER_KEY, other.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        other.subscribe(m, otherPayerSignature, deadline, consent);
        vm.chainId(block.chainid + 1);
        p = sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        subs.subscribe(m, p, deadline, consent);
    }

    function testPayerSignatureIsAlsoRequired() public {
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        bytes memory wrong = sign(MERCHANT_KEY, subs.hashMandate(m));
        bytes memory consent = sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.subscribe(m, wrong, m.endTime, consent);
        assertEq(subs.nonces(payer), 0);
    }

    function testReplaceRequiresFreshConsentAndIsAtomic() public {
        bytes32 id = register();
        SubscriptionManagerV2.Mandate memory m = mandate(1);
        bytes memory p = sign(PAYER_KEY, subs.hashMandate(m));
        vm.expectRevert(SubscriptionManagerV2.InvalidConsent.selector);
        vm.prank(payer);
        subs.replace(id, m, p, m.endTime, "");
        assertFalse(cancelled(id));
        assertEq(subs.nonces(payer), 1);
        bytes memory consent = sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime));
        vm.prank(payer);
        bytes32 replacement = subs.replace(id, m, p, m.endTime, consent);
        assertTrue(cancelled(id));
        assertFalse(cancelled(replacement));
        assertEq(subs.nonces(payer), 2);
        assertFalse(subs.charge(id, 2_000_000));
    }

    function testSignedCancellationWorksWithoutMerchantTankOrPayerGas() public {
        bytes32 id = register();
        assertEq(tank.balanceOf(merchant), 0);
        assertEq(payer.balance, 0);
        uint256 balance = token.balanceOf(payer);
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = sign(PAYER_KEY, subs.hashCancellation(id, deadline));
        vm.prank(address(0xCAFE));
        subs.cancelWithSignature(id, deadline, signature);
        assertTrue(cancelled(id));
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), balance);
        assertEq(tank.balanceOf(merchant), 0);
        assertEq(payer.balance, 0);
        vm.expectRevert(SubscriptionManagerV2.InvalidMandate.selector);
        subs.cancelWithSignature(id, deadline, signature);
    }

    function testCancellationRejectsWrongSignerExpiredAndAlteredAuthorization() public {
        bytes32 id = register();
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = sign(MERCHANT_KEY, subs.hashCancellation(id, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(id, deadline, signature);
        signature = sign(PAYER_KEY, subs.hashCancellation(id, deadline));
        vm.expectRevert(SubscriptionManagerV2.InvalidSignature.selector);
        subs.cancelWithSignature(id, deadline + 1, signature);
        vm.warp(deadline + 1);
        vm.expectRevert(SubscriptionManagerV2.ExpiredCancellation.selector);
        subs.cancelWithSignature(id, deadline, signature);
        assertFalse(cancelled(id));
    }

    function testRenewalLimitsStillApply() public {
        bytes32 id = register();
        assertFalse(subs.charge(id, 2_000_001));
        assertTrue(subs.charge(id, 2_000_000));
        assertFalse(subs.charge(id, 2_000_000));
        vm.warp(block.timestamp + 1 days);
        assertTrue(subs.charge(id, 2_000_000));
        vm.warp(block.timestamp + 31 days);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), 96_000_000);
    }

    function testCancellationCannotCrossSubscriptionOrDomain() public {
        vm.chainId(1874);
        bytes32 first = register();
        SubscriptionManagerV2.Mandate memory m = mandate(1);
        bytes32 second = subs.subscribe(
            m, sign(PAYER_KEY, subs.hashMandate(m)), m.endTime, sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime))
        );
        uint64 deadline = uint64(block.timestamp + 1 hours);
        bytes memory signature = sign(PAYER_KEY, subs.hashCancellation(first, deadline));
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
        SubscriptionManagerV2.Mandate memory m = mandate(0);
        m.maxPeriods = 1;
        bytes32 id = subs.subscribe(
            m, sign(PAYER_KEY, subs.hashMandate(m)), m.endTime, sign(MERCHANT_KEY, subs.hashConsent(m, m.endTime))
        );
        vm.prank(payer);
        token.approve(address(subs), 0);
        assertFalse(subs.charge(id, 2_000_000));
        vm.prank(payer);
        token.approve(address(subs), 4_000_000);
        assertTrue(subs.charge(id, 2_000_000));
        vm.warp(block.timestamp + 1 days);
        assertFalse(subs.charge(id, 2_000_000));
        assertEq(token.balanceOf(payer), 98_000_000);
        assertEq(token.allowance(payer, address(subs)), 2_000_000);
    }
}
