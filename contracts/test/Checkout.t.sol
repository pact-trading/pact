// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {GasTank} from "../src/GasTank.sol";
import {Router} from "../src/Router.sol";
import {MockNoBoolUSDT} from "./mocks/MockNoBoolUSDT.sol";

contract CheckoutTest is Test {
    receive() external payable {}
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;
    address payer;
    address merchant;
    address relayer = address(0xCAFE);
    address other = address(0xBAD);
    MockNoBoolUSDT token;
    PaymentEscrow escrow;
    SubscriptionManager subs;
    GasTank tank;
    Router router;
    bytes32 constant ID = keccak256("payment-1");
    bytes32 constant REASON = keccak256("customer-request");

    function setUp() public {
        payer = vm.addr(PAYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        token = new MockNoBoolUSDT();
        tank = new GasTank();
        router = new Router(IERC20(address(token)), tank, address(this));
        tank.setRouter(address(router));
        escrow = new PaymentEscrow(IERC20(address(token)), address(router));
        subs = new SubscriptionManager(IERC20(address(token)), address(router), address(this));
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
        vm.deal(merchant, 10 ether);
        vm.prank(merchant);
        tank.deposit{value: 1 ether}(merchant);
        vm.prank(merchant);
        tank.setDailyCap(0.5 ether);
        vm.txGasPrice(1 gwei);
        router.setAllowed(address(escrow), escrow.charge.selector, true, false);
    }

    function _authorize(uint256 amount) internal {
        vm.prank(payer);
        escrow.authorize(ID, merchant, amount, uint64(block.timestamp + 1 days), 7 days);
    }

    function testEscrowLifecycleAndNoBoolToken() public {
        _authorize(100_000_000);
        vm.prank(merchant);
        escrow.capture(ID, 60_000_000);
        vm.prank(merchant);
        escrow.refund(ID, 20_000_000, REASON);
        vm.prank(merchant);
        escrow.refund(ID, 40_000_000, REASON);
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        vm.prank(merchant);
        escrow.refund(ID, 1, REASON);
        vm.prank(merchant);
        escrow.void(ID);
        (,, uint256 authorized, uint256 captured, uint256 refunded,,,,) = escrow.payments(ID);
        assertEq(authorized, 100_000_000);
        assertEq(captured, 60_000_000);
        assertEq(refunded, 60_000_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function testChargeRefundAndDuplicateRefused() public {
        vm.prank(payer);
        escrow.charge(ID, merchant, 20_000_000, 1 days);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(payer);
        escrow.charge(ID, merchant, 20_000_000, 1 days);
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
        escrow.capture(ID, 1);
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
        escrow.capture(ID, 1);
        vm.prank(payer);
        escrow.reclaim(ID);
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
        uint256 captured = bound(uint256(captureSeed), 1, 100_000_000);
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
        (,,,, uint256 refunded,,,,) = escrow.payments(ID);
        assertLe(refunded, captured);
    }

    function _mandate(uint256 nonce, uint256 cap, uint32 maxPeriods, uint64 endTime)
        internal
        view
        returns (SubscriptionManager.Mandate memory)
    {
        return SubscriptionManager.Mandate(payer, merchant, keccak256("plan"), cap, 1 days, maxPeriods, endTime, nonce);
    }

    function _signMandate(SubscriptionManager.Mandate memory m) internal view returns (bytes memory) {
        bytes32 digest = subs.hashMandate(m);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _subscribe(uint256 cap, uint32 maxPeriods, uint64 endTime) internal returns (bytes32) {
        SubscriptionManager.Mandate memory m = _mandate(subs.nonces(payer), cap, maxPeriods, endTime);
        return subs.subscribe(m, _signMandate(m));
    }

    function testSubscriptionRefusalsAndCancel() public {
        bytes32 id = _subscribe(10_000_000, 2, uint64(block.timestamp + 4 days));
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.CapExceeded);
        vm.prank(merchant); // cap
        assertFalse(subs.charge(id, 11_000_000));
        vm.prank(merchant);
        assertTrue(subs.charge(id, 10_000_000));
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.TooEarly);
        vm.prank(merchant); // early
        assertFalse(subs.charge(id, 1));
        vm.warp(block.timestamp + 1 days);
        vm.prank(merchant);
        assertTrue(subs.charge(id, 10_000_000));
        vm.warp(block.timestamp + 1 days);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.MaxPeriods);
        vm.prank(merchant); // max periods
        assertFalse(subs.charge(id, 1));
        vm.prank(payer);
        subs.cancel(id);
        vm.expectRevert(SubscriptionManager.InvalidMandate.selector);
        vm.prank(payer);
        subs.cancel(id);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.Cancelled);
        vm.prank(merchant); // cancelled
        assertFalse(subs.charge(id, 1));
    }

    function testSubscriptionExpiryFundsTransferAndAuth() public {
        bytes32 id = _subscribe(10_000_000, 5, uint64(block.timestamp + 2 days));
        vm.prank(other);
        vm.expectRevert(SubscriptionManager.NotAuthorized.selector);
        subs.charge(id, 1);
        vm.prank(payer);
        token.approve(address(subs), 0);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.InsufficientFunds);
        vm.prank(merchant); // insufficient allowance
        assertFalse(subs.charge(id, 1));
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
        token.setFailTransfers(true);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.TransferFailed);
        vm.prank(merchant); // transfer failure
        assertFalse(subs.charge(id, 1));
        token.setFailTransfers(false);
        vm.warp(block.timestamp + 2 days + 1);
        vm.expectEmit(true, false, false, true, address(subs));
        emit SubscriptionManager.Refused(id, SubscriptionManager.Refusal.Expired);
        vm.prank(merchant); // expired
        assertFalse(subs.charge(id, 1));
    }

    function testMandateReplayBadSignatureAndReplace() public {
        SubscriptionManager.Mandate memory m = _mandate(0, 10_000_000, 2, uint64(block.timestamp + 5 days));
        bytes memory sig = _signMandate(m);
        bytes32 id = subs.subscribe(m, sig);
        vm.expectRevert(SubscriptionManager.InvalidMandate.selector);
        subs.subscribe(m, sig);
        SubscriptionManager.Mandate memory next = _mandate(1, 20_000_000, 2, uint64(block.timestamp + 5 days));
        vm.expectRevert(SubscriptionManager.InvalidSignature.selector);
        subs.subscribe(next, sig);
        bytes memory nextSig = _signMandate(next);
        vm.prank(payer);
        bytes32 nextId = subs.replace(id, next, nextSig);
        assertTrue(nextId != id);
        vm.prank(merchant);
        assertFalse(subs.charge(id, 1));
    }

    function _intent(bytes memory data, uint256 nonce) internal view returns (Router.Intent memory) {
        return Router.Intent(
            payer,
            merchant,
            address(escrow),
            keccak256(data),
            10_000_000,
            10_000,
            nonce,
            uint64(block.timestamp + 1 hours),
            500_000
        );
    }

    function _signIntent(Router.Intent memory i) internal view returns (bytes memory) {
        bytes32 digest = router.hashIntent(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _data(bytes32 id) internal view returns (bytes memory) {
        return abi.encodeCall(escrow.charge, (id, merchant, 10_000_000, uint64(1 days)));
    }

    function _execute(Router.Intent memory i, bytes memory data) internal returns (bool ok) {
        (ok,) = router.execute(i, data, _signIntent(i));
    }

    function _executeAs(address signer, uint256 key, address target, bytes memory data, uint256 amount, uint256 nonce)
        internal
        returns (bool ok)
    {
        Router.Intent memory i = Router.Intent(
            signer, merchant, target, keccak256(data), amount, 10_000, nonce, uint64(block.timestamp + 1 hours), 500_000
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, router.hashIntent(i));
        (ok,) = router.execute(i, data, abi.encodePacked(r, s, v));
    }

    function _expectRouterRefusal(Router.Intent memory i, Router.Refusal reason) internal {
        vm.expectEmit(true, true, true, true, address(router));
        emit Router.Refused(i.signer, i.merchant, i.nonce, reason);
    }

    function testRouterSponsoredPaymentAndReplay() public {
        bytes memory data = _data(ID);
        Router.Intent memory i = _intent(data, 1);
        uint256 beforeTank = tank.balanceOf(merchant);
        bytes memory sig = _signIntent(i);
        vm.prank(relayer);
        (bool succeeded,) = router.execute(i, data, sig);
        assertTrue(succeeded);
        assertLt(tank.balanceOf(merchant), beforeTank);
        assertEq(token.balanceOf(address(this)), i.feeUSDT);
        _expectRouterRefusal(i, Router.Refusal.Replay);
        assertFalse(_execute(i, data)); // replay
    }

    function testRouterSponsoredAuthorizeCaptureRefundAndCancel() public {
        router.setAllowed(address(escrow), escrow.authorize.selector, true, false);
        router.setAllowed(address(escrow), escrow.capture.selector, true, false);
        router.setAllowed(address(escrow), escrow.refund.selector, true, false);
        uint256 payerBefore = token.balanceOf(payer);
        bytes memory authorizeData = abi.encodeCall(
            escrow.authorize, (ID, merchant, 10_000_000, uint64(block.timestamp + 1 days), uint64(7 days))
        );
        assertTrue(_executeAs(payer, PAYER_KEY, address(escrow), authorizeData, 10_000_000, 81));
        bytes memory captureData = abi.encodeCall(escrow.capture, (ID, 10_000_000));
        assertTrue(_executeAs(merchant, MERCHANT_KEY, address(escrow), captureData, 10_000_000, 82));
        bytes memory refundData = abi.encodeCall(escrow.refund, (ID, 5_000_000, REASON));
        assertTrue(_executeAs(merchant, MERCHANT_KEY, address(escrow), refundData, 5_000_000, 83));
        assertEq(token.balanceOf(payer), payerBefore - 5_000_000);
        bytes32 subscriptionId = _subscribe(10_000_000, 2, uint64(block.timestamp + 2 days));
        router.setAllowed(address(subs), subs.cancel.selector, true, false);
        bytes memory cancelData = abi.encodeCall(subs.cancel, (subscriptionId));
        assertTrue(_executeAs(payer, PAYER_KEY, address(subs), cancelData, 10_000_000, 84));
        vm.prank(merchant);
        assertFalse(subs.charge(subscriptionId, 1));
    }

    function testRouterRefusalPaths() public {
        bytes memory data = _data(ID);
        Router.Intent memory i = _intent(data, 2);
        _expectRouterRefusal(i, Router.Refusal.InvalidSignature);
        (bool ok,) = router.execute(i, data, hex"1234"); // signature
        assertFalse(ok);
        i.deadline = uint64(block.timestamp - 1); // stale
        _expectRouterRefusal(i, Router.Refusal.Deadline);
        assertFalse(_execute(i, data));
        i = _intent(data, 2); // wrong target
        i.target = address(subs);
        _expectRouterRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, data));
        i = _intent(data, 2); // data hash
        _expectRouterRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, abi.encodeCall(escrow.refund, (ID, 1, REASON))));
        router.setAllowed(address(escrow), escrow.refund.selector, true, false);
        bytes memory refundData = abi.encodeCall(escrow.refund, (ID, 1, REASON));
        i = _intent(refundData, 2); // quote mismatch (no payment)
        _expectRouterRefusal(i, Router.Refusal.QuoteMismatch);
        assertFalse(_execute(i, refundData));
        i = _intent(data, 2); // quote mismatch
        i.amount = 1;
        _expectRouterRefusal(i, Router.Refusal.QuoteMismatch);
        assertFalse(_execute(i, data));
        i = _intent(data, 2); // dust
        i.amount = 10_000_000;
        router.setLimits(20_000_000, 1_000_000, 10, 1_000_000, 100 gwei);
        _expectRouterRefusal(i, Router.Refusal.Dust);
        assertFalse(_execute(i, data));
        router.setLimits(1_000_000, 1_000_000, 10, 1_000_000, 100 gwei);
        i.maxGas = 1_000_001; // gas limit
        _expectRouterRefusal(i, Router.Refusal.GasLimit);
        assertFalse(_execute(i, data));
        i = _intent(data, 2); // fee
        i.feeUSDT = 0;
        _expectRouterRefusal(i, Router.Refusal.FeeTooLow);
        assertFalse(_execute(i, data));
        i = _intent(data, 2); // merchant cap
        vm.prank(merchant);
        tank.setDailyCap(1);
        _expectRouterRefusal(i, Router.Refusal.TankLimit);
        assertFalse(_execute(i, data));
        vm.prank(merchant);
        tank.setDailyCap(0.5 ether);
        vm.prank(merchant); // fee unavailable
        token.approve(address(router), 0);
        _expectRouterRefusal(i, Router.Refusal.FeeUnavailable);
        assertFalse(_execute(i, data));
        vm.prank(merchant);
        token.approve(address(router), type(uint256).max);
        token.setFailTransfers(true); // target failed
        _expectRouterRefusal(i, Router.Refusal.TargetFailed);
        assertFalse(_execute(i, data));
    }

    function testRouterPayerDailyCapAndPerMerchantIsolation() public {
        router.setLimits(1_000_000, 1_000_000, 1, 1_000_000, 100 gwei);
        bytes memory data = _data(ID);
        assertTrue(_execute(_intent(data, 1), data));
        bytes memory next = _data(keccak256("next"));
        Router.Intent memory nextIntent = _intent(next, 2);
        _expectRouterRefusal(nextIntent, Router.Refusal.PayerDailyCap);
        assertFalse(_execute(nextIntent, next));
        vm.deal(other, 1 ether);
        vm.prank(other);
        tank.deposit{value: 1 ether}(other);
        assertEq(tank.balanceOf(other), 1 ether);
    }

    function testRouterGasPriceAndBadTargetSelector() public {
        bytes memory data = _data(ID);
        Router.Intent memory i = _intent(data, 41);
        vm.txGasPrice(101 gwei);
        _expectRouterRefusal(i, Router.Refusal.GasPrice);
        assertFalse(_execute(i, data));
        vm.txGasPrice(1 gwei);
        bytes memory wrongSelector = abi.encodeWithSelector(bytes4(0xdeadbeef), ID);
        i = _intent(wrongSelector, 42);
        _expectRouterRefusal(i, Router.Refusal.WrongSelector);
        assertFalse(_execute(i, wrongSelector));
        assertEq(tank.balanceOf(merchant), 1 ether);
    }

    function testRouterCannotReimburseRefusedRenewal() public {
        bytes32 id = _subscribe(10_000_000, 3, uint64(block.timestamp + 4 days));
        vm.prank(merchant);
        assertTrue(subs.charge(id, 10_000_000));
        router.setAllowed(address(subs), subs.charge.selector, true, true);
        bytes memory data = abi.encodeCall(subs.charge, (id, 10_000_000));
        Router.Intent memory i = Router.Intent(
            merchant,
            merchant,
            address(subs),
            keccak256(data),
            10_000_000,
            10_000,
            71,
            uint64(block.timestamp + 1 hours),
            500_000
        );
        bytes32 digest = router.hashIntent(i);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MERCHANT_KEY, digest);
        uint256 beforeTank = tank.balanceOf(merchant);
        _expectRouterRefusal(i, Router.Refusal.TargetRefused);
        (bool ok,) = router.execute(i, data, abi.encodePacked(r, s, v));
        assertFalse(ok);
        assertEq(tank.balanceOf(merchant), beforeTank);
        assertTrue(router.usedNonces(merchant, 71));
    }

    function testGasTankRefusalAndWithdrawalPaths() public {
        vm.expectRevert(GasTank.InvalidValue.selector);
        tank.deposit{value: 0}(merchant);
        vm.expectRevert(GasTank.InvalidValue.selector);
        tank.deposit{value: 1}(address(0));
        vm.expectRevert(GasTank.NotAuthorized.selector);
        tank.reimburse(merchant, payable(relayer), 1);
        vm.expectRevert(GasTank.InsufficientTank.selector);
        vm.prank(merchant);
        tank.withdraw(2 ether);
        vm.prank(merchant);
        tank.setDailyCap(1);
        assertFalse(tank.canReimburse(merchant, 2));
        vm.expectRevert(GasTank.DailyCapExceeded.selector);
        vm.prank(address(router));
        tank.reimburse(merchant, payable(relayer), 2);
        uint256 beforeBalance = merchant.balance;
        vm.prank(merchant);
        tank.withdraw(0.5 ether);
        assertEq(merchant.balance, beforeBalance + 0.5 ether);
        assertEq(tank.balanceOf(merchant), 0.5 ether);
    }
}
