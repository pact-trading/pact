// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeSchedule} from "../src/FeeSchedule.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {Router} from "../src/Router.sol";
import {PactSuite} from "./utils/PactSuite.sol";

contract CheckoutTest is PactSuite {
    bytes32 constant ID = keccak256("payment-1");
    bytes32 constant REASON = keccak256("customer-request");

    function setUp() public {
        vm.warp(10 days);
        _deploy();
        token.mint(payer, 1_000_000_000);
        token.mint(merchant, 1_000_000_000);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(router), type(uint256).max);
    }

    function _authorize(uint256 amount) internal {
        vm.prank(payer);
        escrow.authorize(ID, merchant, amount, uint64(block.timestamp + 1 days), 7 days);
    }

    function _chargeData(bytes32 id, uint256 amount) internal view returns (bytes memory) {
        return abi.encodeCall(escrow.charge, (id, merchant, amount, uint64(1 days)));
    }

    // ------------------------------------------------------------------ escrow and fees

    function testChargePaysTheMerchantLessTheFee() public {
        uint256 fee = _checkoutFee(100_000_000);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit PaymentEscrow.Charged(
            ID, payer, merchant, 100_000_000, fee, 0, uint64(block.timestamp + 1 days), 1 days, relayer
        );
        vm.prank(payer);
        escrow.charge(ID, merchant, 100_000_000, 1 days);
        assertEq(fee, 800_000);
        assertEq(token.balanceOf(payer), 900_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 100_000_000 - fee);
        assertEq(token.balanceOf(relayer), fee);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testInvoiceChargesUseTheCappedInvoiceRate() public {
        token.mint(payer, 5_000_000_000);
        vm.prank(payer);
        escrow.chargeInvoice(ID, merchant, 5_000_000_000, 30 days);
        assertEq(token.balanceOf(relayer), 10_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 5_000_000_000 - 10_000_000);
        vm.prank(payer);
        escrow.chargeInvoice(keccak256("small"), merchant, 1_000_000_000, 30 days);
        assertEq(token.balanceOf(relayer), 10_000_000 + _invoiceFee(1_000_000_000));
    }

    function testAMerchantWithoutTermsCannotBePaidAndDustCannotCoverTheFee() public {
        address newcomer = address(0x1234);
        vm.expectRevert(FeeSchedule.TermsNotAccepted.selector);
        vm.prank(payer);
        escrow.charge(ID, newcomer, 10_000_000, 1 days);
        vm.expectRevert(FeeSchedule.FeeExceedsAmount.selector);
        vm.prank(payer);
        escrow.charge(ID, merchant, 100_000, 1 days);
        assertEq(escrow.payment(ID).payer, address(0));
    }

    function testEscrowLifecycleTakesTheFeeOnCaptureAndRefundsInFull() public {
        _authorize(100_000_000);
        // Authorizing carries no fee: the money waits in escrow.
        assertEq(token.balanceOf(address(escrow)), 100_000_000);
        assertEq(token.balanceOf(relayer), 0);
        uint256 fee = _checkoutFee(60_000_000);
        vm.expectEmit(true, false, false, true, address(escrow));
        emit PaymentEscrow.Captured(ID, 60_000_000, fee, uint64(block.timestamp + 7 days), 7 days, relayer);
        vm.prank(merchant);
        escrow.capture(ID, 60_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 60_000_000 - fee);
        assertEq(token.balanceOf(relayer), fee);
        // Refunds return the full captured amount from the merchant's wallet; the fee is kept.
        vm.prank(merchant);
        escrow.refund(ID, 20_000_000, REASON);
        vm.prank(merchant);
        escrow.refund(ID, 40_000_000, REASON);
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        vm.prank(merchant);
        escrow.refund(ID, 1, REASON);
        vm.prank(merchant);
        escrow.void(ID);
        PaymentEscrow.PaymentView memory p = escrow.payment(ID);
        assertEq(p.authorized, 100_000_000);
        assertEq(p.captured, 60_000_000);
        assertEq(p.refunded, 60_000_000);
        assertTrue(p.closed);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(payer), 1_000_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 - fee);
        assertEq(token.balanceOf(relayer), fee);
    }

    function testChargeRefundAndDuplicateRefused() public {
        vm.prank(payer);
        escrow.charge(ID, merchant, 20_000_000, 1 days);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(payer);
        escrow.charge(ID, merchant, 20_000_000, 1 days);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(payer);
        escrow.chargeInvoice(ID, merchant, 20_000_000, 1 days);
        vm.prank(merchant);
        escrow.refund(ID, 20_000_000, REASON);
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        vm.prank(merchant);
        escrow.refund(ID, 1, REASON);
    }

    function testEscrowRefusalPaths() public {
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        vm.prank(payer);
        escrow.authorize(ID, merchant, 0, uint64(block.timestamp + 1 days), 1 days);
        vm.expectRevert(PaymentEscrow.Expired.selector);
        vm.prank(payer);
        escrow.authorize(ID, merchant, 1, uint64(block.timestamp), 1 days);
        _authorize(10_000_000);
        vm.expectRevert(PaymentEscrow.NotAuthorized.selector);
        vm.prank(other);
        escrow.capture(ID, 1_000_000);
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        vm.prank(merchant);
        escrow.capture(ID, 11_000_000);
        vm.expectRevert(PaymentEscrow.TooEarly.selector);
        vm.prank(payer);
        escrow.reclaim(ID);
        vm.expectRevert(PaymentEscrow.NotAuthorized.selector);
        vm.prank(other);
        escrow.void(ID);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(PaymentEscrow.Expired.selector);
        vm.prank(merchant);
        escrow.capture(ID, 1_000_000);
        vm.prank(payer);
        escrow.reclaim(ID);
        assertEq(token.balanceOf(payer), 1_000_000_000);
        assertEq(token.balanceOf(relayer), 0);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(merchant);
        escrow.void(ID);
        vm.expectRevert(PaymentEscrow.RefundWindowClosed.selector);
        vm.prank(merchant);
        escrow.refund(ID, 1, REASON);
    }

    function testRefundWindowClosed() public {
        vm.prank(payer);
        escrow.charge(ID, merchant, 10_000_000, 1 days);
        vm.warp(block.timestamp + 1 days + 1);
        vm.expectRevert(PaymentEscrow.RefundWindowClosed.selector);
        vm.prank(merchant);
        escrow.refund(ID, 1, REASON);
    }

    function testFuzzRefundsNeverExceedCaptured(uint96 captureSeed, uint96 refundASeed, uint96 refundBSeed) public {
        uint256 captured = bound(uint256(captureSeed), 150_000, 100_000_000);
        uint256 a = bound(uint256(refundASeed), 0, captured);
        uint256 b = bound(uint256(refundBSeed), 0, captured);
        _authorize(100_000_000);
        vm.prank(merchant);
        escrow.capture(ID, captured);
        if (a > 0) {
            vm.prank(merchant);
            escrow.refund(ID, a, REASON);
        }
        if (b > captured - a) {
            vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
            vm.prank(merchant);
            escrow.refund(ID, b, REASON);
        } else if (b > 0) {
            vm.prank(merchant);
            escrow.refund(ID, b, REASON);
        }
        assertLe(escrow.payment(ID).refunded, captured);
        assertEq(token.balanceOf(relayer), _checkoutFee(captured));
    }

    // ------------------------------------------------------------------ router

    function testRouterSponsoredPaymentNetsTheFeeAndRefusesReplay() public {
        bytes memory data = _chargeData(ID, 10_000_000);
        Router.Intent memory i = _intent(payer, address(escrow), data, 10_000_000, 1);
        vm.expectEmit(true, true, true, true, address(router));
        emit Router.Executed(payer, merchant, 1, address(escrow), 0);
        assertTrue(_execute(i, data));
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 10_000_000 - 150_000);
        assertEq(token.balanceOf(relayer), 150_000);
        // The merchant's Router allowance was never touched by a payment.
        assertEq(token.allowance(merchant, address(router)), type(uint256).max);
        _expectRefusal(i, Router.Refusal.Replay);
        assertFalse(_execute(i, data));
    }

    function testAnyoneCanSubmitButOnlyTheRecipientIsPaid() public {
        bytes memory data = _chargeData(ID, 10_000_000);
        Router.Intent memory i = _intent(payer, address(escrow), data, 10_000_000, 1);
        bytes memory signature = _sign(PAYER_KEY, router.hashIntent(i));
        vm.prank(other);
        (bool ok,) = router.execute(i, data, signature);
        assertTrue(ok);
        assertEq(token.balanceOf(other), 0);
        assertEq(other.balance, 0);
        assertEq(token.balanceOf(relayer), 150_000);
    }

    function testSponsoredRefundChargesTheMerchantItsGasInUsdt() public {
        bytes memory authorizeData = abi.encodeCall(
            escrow.authorize, (ID, merchant, 10_000_000, uint64(block.timestamp + 1 days), uint64(7 days))
        );
        assertTrue(_execute(_intent(payer, address(escrow), authorizeData, 10_000_000, 81), authorizeData));
        bytes memory captureData = abi.encodeCall(escrow.capture, (ID, 10_000_000));
        assertTrue(_execute(_intent(merchant, address(escrow), captureData, 10_000_000, 82), captureData));
        uint256 merchantBefore = token.balanceOf(merchant);
        uint256 relayerBefore = token.balanceOf(relayer);
        uint256 payerBefore = token.balanceOf(payer);
        bytes memory refundData = abi.encodeCall(escrow.refund, (ID, 5_000_000, REASON));
        Router.Intent memory i = _intent(merchant, address(escrow), refundData, 5_000_000, 83);
        assertTrue(_execute(i, refundData));
        uint256 gasFee = token.balanceOf(relayer) - relayerBefore;
        assertGt(gasFee, 0);
        assertLe(gasFee, router.maxGasFee(i.maxGas, PRICE));
        assertEq(token.balanceOf(payer), payerBefore + 5_000_000);
        assertEq(token.balanceOf(merchant), merchantBefore - 5_000_000 - gasFee);
    }

    function testRefundGasNeedsTheMerchantsSignatureAllowanceAndBalance() public {
        vm.prank(payer);
        escrow.charge(ID, merchant, 10_000_000, 1 days);
        bytes memory refundData = abi.encodeCall(escrow.refund, (ID, 5_000_000, REASON));
        // A payer-signed refund naming the merchant cannot spend the merchant's allowance.
        Router.Intent memory i = _intent(payer, address(escrow), refundData, 5_000_000, 90);
        _expectRefusal(i, Router.Refusal.SignerNotMerchant);
        assertFalse(_execute(i, refundData));
        i = _intent(merchant, address(escrow), refundData, 5_000_000, 91);
        uint256 ceiling = router.maxGasFee(i.maxGas, PRICE);
        vm.prank(merchant);
        token.approve(address(router), ceiling - 1);
        _expectRefusal(i, Router.Refusal.FeeUnavailable);
        assertFalse(_execute(i, refundData));
        assertFalse(router.usedNonces(merchant, 91));
        vm.prank(merchant);
        token.approve(address(router), type(uint256).max);
        // The merchant must hold the refund and the gas ceiling.
        uint256 keep = 5_000_000 + ceiling - 1;
        uint256 surplus = token.balanceOf(merchant) - keep;
        vm.prank(merchant);
        token.transfer(other, surplus);
        _expectRefusal(i, Router.Refusal.FeeUnavailable);
        assertFalse(_execute(i, refundData));
        token.mint(merchant, 1);
        assertTrue(_execute(i, refundData));
    }

    function testRouterRefusalPaths() public {
        bytes memory data = _chargeData(ID, 10_000_000);
        Router.Intent memory i = _intent(payer, address(escrow), data, 10_000_000, 2);
        _expectRefusal(i, Router.Refusal.InvalidSignature);
        (bool ok,) = router.execute(i, data, hex"1234");
        assertFalse(ok);
        i.deadline = uint64(block.timestamp - 1);
        _expectRefusal(i, Router.Refusal.Deadline);
        assertFalse(_execute(i, data));
        i = _intent(payer, address(subs), data, 10_000_000, 2); // wrong target
        _expectRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, data));
        i = _intent(payer, address(escrow), data, 10_000_000, 2); // data hash
        _expectRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, abi.encodeCall(escrow.refund, (ID, 1, REASON))));
        bytes memory refundData = abi.encodeCall(escrow.refund, (ID, 1, REASON));
        i = _intent(merchant, address(escrow), refundData, 1, 2); // quote mismatch (no payment)
        _expectRefusal(i, Router.Refusal.QuoteMismatch);
        assertFalse(_execute(i, refundData));
        i = _intent(payer, address(escrow), data, 1, 2); // amount mismatch
        _expectRefusal(i, Router.Refusal.QuoteMismatch);
        assertFalse(_execute(i, data));
        i = _intent(payer, address(escrow), data, 10_000_000, 2); // dust
        router.setLimits(20_000_000, 10, 1_000_000, 100 gwei);
        _expectRefusal(i, Router.Refusal.Dust);
        assertFalse(_execute(i, data));
        router.setLimits(1_000_000, 10, 1_000_000, 100 gwei);
        i.maxGas = 1_000_001; // gas limit
        _expectRefusal(i, Router.Refusal.GasLimit);
        assertFalse(_execute(i, data));
        i = _intent(payer, address(escrow), data, 10_000_000, 2); // target failed
        token.setFailTransfers(true);
        _expectRefusal(i, Router.Refusal.TargetFailed);
        assertFalse(_execute(i, data));
        token.setFailTransfers(false);
        // A failed target consumed the nonce; a fresh one goes through.
        assertTrue(router.usedNonces(payer, 2));
        i = _intent(payer, address(escrow), data, 10_000_000, 3);
        assertTrue(_execute(i, data));
    }

    function testVoidAndReclaimSkipTheMinimumAmount() public {
        bytes memory authorizeData = abi.encodeCall(
            escrow.authorize, (ID, merchant, 1_200_000, uint64(block.timestamp + 1 days), uint64(7 days))
        );
        assertTrue(_execute(_intent(payer, address(escrow), authorizeData, 1_200_000, 1), authorizeData));
        bytes memory captureData = abi.encodeCall(escrow.capture, (ID, 1_000_000));
        assertTrue(_execute(_intent(merchant, address(escrow), captureData, 1_000_000, 2), captureData));
        // 0.2 USDT is left: below the minimum, yet the merchant can still release it for free.
        bytes memory voidData = abi.encodeCall(escrow.void, (ID));
        uint256 relayerBefore = token.balanceOf(relayer);
        assertTrue(_execute(_intent(merchant, address(escrow), voidData, 200_000, 3), voidData));
        assertEq(token.balanceOf(relayer), relayerBefore);
        assertEq(token.balanceOf(payer), 1_000_000_000 - 1_000_000);
    }

    function testRouterPayerDailyCap() public {
        router.setLimits(1_000_000, 1, 1_000_000, 100 gwei);
        bytes memory data = _chargeData(ID, 10_000_000);
        assertTrue(_execute(_intent(payer, address(escrow), data, 10_000_000, 1), data));
        bytes memory next = _chargeData(keccak256("next"), 10_000_000);
        Router.Intent memory nextIntent = _intent(payer, address(escrow), next, 10_000_000, 2);
        _expectRefusal(nextIntent, Router.Refusal.PayerDailyCap);
        assertFalse(_execute(nextIntent, next));
        vm.warp(block.timestamp + 1 days);
        nextIntent.deadline = uint64(block.timestamp + 1 hours);
        assertTrue(_execute(nextIntent, next));
    }

    function testRouterGasPriceAndBadTargetSelector() public {
        bytes memory data = _chargeData(ID, 10_000_000);
        Router.Intent memory i = _intent(payer, address(escrow), data, 10_000_000, 41);
        vm.txGasPrice(101 gwei);
        _expectRefusal(i, Router.Refusal.GasPrice);
        assertFalse(_execute(i, data));
        vm.txGasPrice(PRICE);
        bytes memory wrongSelector = abi.encodeWithSelector(bytes4(0xdeadbeef), ID);
        i = _intent(payer, address(escrow), wrongSelector, 10_000_000, 42);
        _expectRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, wrongSelector));
    }

    function testRouterCannotChargeForARefusedRenewal() public {
        SubscriptionManagerV2.Mandate memory m = SubscriptionManagerV2.Mandate(
            payer, merchant, keccak256("plan"), 10_000_000, 1 days, 3, uint64(block.timestamp + 4 days), 0
        );
        bytes32 id = subs.subscribe(m, _sign(PAYER_KEY, subs.hashMandate(m)));
        vm.prank(merchant);
        assertTrue(subs.charge(id, 10_000_000));
        bytes memory data = abi.encodeCall(subs.charge, (id, 10_000_000));
        Router.Intent memory i = _intent(merchant, address(subs), data, 10_000_000, 71);
        uint256 relayerBefore = token.balanceOf(relayer);
        _expectRefusal(i, Router.Refusal.TargetRefused);
        assertFalse(_execute(i, data));
        assertEq(token.balanceOf(relayer), relayerBefore);
        assertTrue(router.usedNonces(merchant, 71));
    }

    function testOnlyTheOwnerConfiguresTheRouter() public {
        vm.expectRevert(Router.NotOwner.selector);
        vm.prank(other);
        router.setAllowed(address(escrow), escrow.charge.selector, false, false, false, false);
        vm.expectRevert(Router.NotOwner.selector);
        vm.prank(other);
        router.setLimits(1, 1, 1, 1);
        vm.expectRevert(Router.InvalidConfig.selector);
        router.setAllowed(other, escrow.charge.selector, true, false, false, true);
        vm.expectRevert(Router.InvalidConfig.selector);
        router.setLimits(0, 10, 1_000_000, 100 gwei);
        (bool enabled, bool mustReturnTrue, bool chargesGas, bool checksAmount) =
            router.allowed(address(escrow), escrow.refund.selector);
        assertTrue(enabled && chargesGas && checksAmount);
        assertFalse(mustReturnTrue);
    }
}
