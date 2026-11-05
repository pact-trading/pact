// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Router} from "../src/Router.sol";
import {GasTank} from "../src/GasTank.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {MockNoBoolUSDT} from "./mocks/MockNoBoolUSDT.sol";
import {RejectReimbursement} from "./GasTankAccounting.t.sol";

contract GasTestTarget {
    address immutable merchant;
    uint256 public calls;

    constructor(address merchant_) {
        merchant = merchant_;
    }

    function sponsorshipQuote(bytes calldata) external view returns (address, uint256) {
        return (merchant, 1_000_000);
    }

    // Consume most of the target allowance without depending on compiler loop costs.
    function burn(uint256 remaining) external returns (bool) {
        calls++;
        while (gasleft() > remaining) {}
        return true;
    }

    function refuse() external pure returns (bool) {
        return false;
    }

    function fail() external pure {
        revert("target failed");
    }

    function requireGas(uint256 minimum) external view returns (bool) {
        require(gasleft() >= minimum, "target allowance was clipped");
        return true;
    }
}

contract RouterGasTest is Test {
    uint256 constant KEY = 0xA11CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;
    uint256 constant PRICE = 1 gwei;
    address payer;
    address merchant;
    address relayer = address(0xCAFE);
    address vault = address(0xFEE);
    MockNoBoolUSDT token;
    GasTank tank;
    Router router;
    PaymentEscrow escrow;
    GasTestTarget target;

    function setUp() public {
        vm.warp(10 days);
        vm.txGasPrice(PRICE);
        payer = vm.addr(KEY);
        merchant = vm.addr(MERCHANT_KEY);
        token = new MockNoBoolUSDT();
        tank = new GasTank();
        router = new Router(IERC20(address(token)), tank, vault);
        tank.setRouter(address(router));
        escrow = new PaymentEscrow(IERC20(address(token)), address(router));
        target = new GasTestTarget(merchant);
        router.setAllowed(address(escrow), escrow.charge.selector, true, false);
        router.setAllowed(address(escrow), escrow.refund.selector, true, false);
        router.setAllowed(address(target), target.burn.selector, true, true);
        router.setAllowed(address(target), target.refuse.selector, true, true);
        router.setAllowed(address(target), target.fail.selector, true, false);
        router.setAllowed(address(target), target.requireGas.selector, true, true);
        token.mint(payer, 10_000_000);
        token.mint(merchant, 10_000_000);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(router), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(escrow), type(uint256).max);
        vm.deal(merchant, 1 ether);
        vm.prank(merchant);
        tank.deposit{value: 1 ether}(merchant);
        vm.prank(merchant);
        tank.setDailyCap(1 ether);
    }

    function _intent(address to, bytes memory data, uint32 maxGas) internal view returns (Router.Intent memory) {
        return Router.Intent(
            payer, merchant, to, keccak256(data), 1_000_000, 10_000, 1, uint64(block.timestamp + 1 hours), maxGas
        );
    }

    function _signature(Router.Intent memory i) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(i.signer == merchant ? MERCHANT_KEY : KEY, router.hashIntent(i));
        return abi.encodePacked(r, s, v);
    }

    function _execute(Router.Intent memory i, bytes memory data, uint256 gasLimit)
        internal
        returns (bool outerOK, bool executed, bytes memory result)
    {
        bytes memory payload = abi.encodeCall(router.execute, (i, data, _signature(i)));
        vm.prank(relayer);
        (outerOK, result) = address(router).call{gas: gasLimit}(payload);
        if (outerOK) (executed, result) = abi.decode(result, (bool, bytes));
    }

    function _expectRefusal(Router.Intent memory i, Router.Refusal reason) internal {
        vm.expectEmit(true, true, true, true, address(router));
        emit Router.Refused(i.signer, i.merchant, i.nonce, reason);
    }

    function _assertUntouched(bool consumed) internal view {
        assertEq(router.usedNonces(payer, 1), consumed);
        (, uint32 count) = router.payerDaily(payer);
        assertEq(count, consumed ? 1 : 0);
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
        assertEq(tank.balanceOf(merchant), 1 ether);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertEq(spent, 0);
        assertEq(relayer.balance, 0);
        assertEq(token.balanceOf(vault), 0);
        assertEq(token.balanceOf(payer), 10_000_000);
        assertEq(token.balanceOf(merchant), 10_000_000);
    }

    function testInsufficientOuterGasReturnsGasLimitAndSameSignatureCanRetry() public {
        bytes memory data = abi.encodeCall(escrow.charge, (keccak256("gas"), merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(address(escrow), data, 500_000);
        _expectRefusal(i, Router.Refusal.GasLimit);
        (bool outerOK, bool executed, bytes memory result) = _execute(i, data, 150_000);
        assertTrue(outerOK, "a successful EVM call can be a business refusal");
        assertFalse(executed);
        assertEq(result.length, 0);
        _assertUntouched(false);

        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertTrue(router.usedNonces(payer, i.nonce));
        assertEq(token.balanceOf(payer), 9_000_000);
        assertEq(token.balanceOf(merchant), 11_000_000 - i.feeUSDT);
        assertEq(token.balanceOf(vault), i.feeUSDT);
        uint256 reimbursed = 1 ether - tank.balanceOf(merchant);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertGt(reimbursed, 0);
        assertEq(relayer.balance, reimbursed);
        assertEq(spent, reimbursed);
        assertEq(address(tank).balance, tank.balanceOf(merchant));
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
    }

    function testApiGasBudgetCanExecuteCharge() public {
        _assertApiCharge(400_000, "API_CHARGE_EXECUTION_GAS");
    }

    function testApiGasBudgetCanExecuteAtPolicyLimit() public {
        _assertApiCharge(1_000_000, "API_LIMIT_EXECUTION_GAS");
    }

    function testApiGasBudgetCanExecuteRefund() public {
        bytes32 paymentId = keccak256("api-refund");
        vm.prank(payer);
        escrow.charge(paymentId, merchant, 1_000_000, uint64(1 days));
        bytes memory data = abi.encodeCall(escrow.refund, (paymentId, 1_000_000, keccak256("requested")));
        Router.Intent memory i = _intent(address(escrow), data, 400_000);
        i.signer = merchant;
        uint256 allowance = vm.envOr("API_REFUND_EXECUTION_GAS", uint256(i.maxGas) + uint256(i.maxGas) / 63 + 320_000);
        (bool outerOK, bool executed,) = _execute(i, data, allowance);
        assertTrue(outerOK, "API refund gas budget cannot pass Router forwarding guard");
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 10_000_000);
    }

    function _assertApiCharge(uint32 maxGas, string memory envKey) internal {
        bytes memory data = abi.encodeCall(escrow.charge, (keccak256("api-gas"), merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(address(escrow), data, maxGas);
        // The API adds intrinsic calldata gas separately; this is the execution allowance.
        uint256 allowance = vm.envOr(envKey, uint256(maxGas) + uint256(maxGas) / 63 + 320_000);
        (bool outerOK, bool executed,) = _execute(i, data, allowance);
        assertTrue(outerOK, "API gas budget cannot pass Router forwarding guard");
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 9_000_000);
    }

    function testExtremelyLowOuterGasRevertsAndRollsBack() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _intent(address(target), data, 500_000);
        (bool outerOK,,) = _execute(i, data, 5_000);
        assertFalse(outerOK);
        _assertUntouched(false);
    }

    function testZeroAndAbovePolicyMaxGasRefuseEvenWithEnoughOuterGas() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _intent(address(target), data, 0);
        _expectRefusal(i, Router.Refusal.GasLimit);
        (bool outerOK, bool executed,) = _execute(i, data, 2_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        i.maxGas = router.maxGasPerCall() + 1;
        _expectRefusal(i, Router.Refusal.GasLimit);
        (outerOK, executed,) = _execute(i, data, 2_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(false);
    }

    function testTargetRevertConsumesNonceAndDailyCountWithoutPayment() public {
        bytes memory data = abi.encodeCall(target.fail, ());
        Router.Intent memory i = _intent(address(target), data, 500_000);
        _expectRefusal(i, Router.Refusal.TargetFailed);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(true);
        _expectRefusal(i, Router.Refusal.Replay);
        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(true);
    }

    function testTargetFalseConsumesNonceAndDailyCountWithoutPayment() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _intent(address(target), data, 500_000);
        _expectRefusal(i, Router.Refusal.TargetRefused);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(true);
    }

    function testTargetOutOfGasConsumesNonceButDoesNotReimburse() public {
        bytes memory data = abi.encodeCall(target.burn, (0));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        _expectRefusal(i, Router.Refusal.TargetFailed);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        assertEq(target.calls(), 0);
        _assertUntouched(true);
    }

    function testReimbursementCannotExceedPreflightBudget() public {
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        uint256 budget = (uint256(i.maxGas) + 40_000) * PRICE;
        i.feeUSDT = (budget * router.usdtPerWBT() + 1e18 - 1) / 1e18;
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertLe(relayer.balance, budget, "reimbursement exceeds fee-covered preflight budget");
        assertEq(tank.balanceOf(merchant), 1 ether - relayer.balance);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertEq(spent, relayer.balance);
    }

    function testExactPreflightTankAndDailyCapCanPayGasHeavySuccess() public {
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        uint256 budget = (uint256(i.maxGas) + 40_000) * PRICE;
        vm.startPrank(merchant);
        tank.withdraw(1 ether - budget);
        tank.setDailyCap(budget);
        vm.stopPrank();
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK, "preflight accepted a budget that settlement exceeded");
        assertTrue(executed);
        assertEq(target.calls(), 1);
        assertEq(tank.balanceOf(merchant), 0);
        assertEq(address(tank).balance, 0);
        assertEq(relayer.balance, budget);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertEq(spent, budget);
    }

    function testGasLostAfterEarlyGuardMustNotConsumeIntent() public {
        bytes memory data = abi.encodeCall(target.requireGas, (490_000));
        Router.Intent memory i = _intent(address(target), data, 500_000);
        (bool outerOK,, bytes memory result) = _execute(i, data, 620_000);
        assertFalse(outerOK, "insufficient forwarding or settlement gas must roll back");
        assertEq(result, abi.encodeWithSignature("InsufficientExecutionGas()"));
        _assertUntouched(false);
        assertEq(target.calls(), 0);
        bool executed;
        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
    }

    function testFeeCeilingRoundsUpAndOneUnitUnderRefusesWithoutConsumingNonce() public {
        vm.txGasPrice(PRICE + 1);
        bytes memory data = abi.encodeCall(target.requireGas, (1));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        uint256 budget = (uint256(i.maxGas) + 40_000) * (PRICE + 1);
        uint256 fee = (budget * router.usdtPerWBT() + 1e18 - 1) / 1e18;
        assertEq(fee, 241);
        i.feeUSDT = fee - 1;
        _expectRefusal(i, Router.Refusal.FeeTooLow);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(false);
        i.feeUSDT = fee;
        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(token.balanceOf(vault), fee);
        assertLe(relayer.balance, budget);
    }

    function testTankBalanceOneWeiUnderPreflightBudgetRefusesWithoutConsumingNonce() public {
        bytes memory data = abi.encodeCall(target.requireGas, (1));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        uint256 budget = (uint256(i.maxGas) + 40_000) * PRICE;
        vm.prank(merchant);
        tank.withdraw(1 ether - budget + 1);
        _expectRefusal(i, Router.Refusal.TankLimit);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        assertFalse(router.usedNonces(payer, 1));
        assertEq(tank.balanceOf(merchant), budget - 1);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertEq(spent, 0);
        assertEq(token.balanceOf(vault), 0);
        assertEq(relayer.balance, 0);
    }

    function testTankCapOneWeiUnderPreflightBudgetRefusesWithoutConsumingNonce() public {
        bytes memory data = abi.encodeCall(target.requireGas, (1));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        uint256 budget = (uint256(i.maxGas) + 40_000) * PRICE;
        vm.prank(merchant);
        tank.setDailyCap(budget - 1);
        _expectRefusal(i, Router.Refusal.TankLimit);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(false);
    }

    function testFeeTransferFailureRollsBackTargetNonceAndAccounting() public {
        token.setFailTransfers(true);
        bytes memory data = abi.encodeCall(target.burn, (150_000));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        (bool outerOK,,) = _execute(i, data, 1_000_000);
        assertFalse(outerOK);
        assertEq(target.calls(), 0);
        _assertUntouched(false);
    }

    function testRejectedReimbursementRollsBackTargetFeeNonceAndAccounting() public {
        RejectReimbursement rejector = new RejectReimbursement();
        relayer = address(rejector);
        bytes memory data = abi.encodeCall(target.burn, (150_000));
        Router.Intent memory i = _intent(address(target), data, 200_000);
        (bool outerOK,, bytes memory result) = _execute(i, data, 1_000_000);
        assertFalse(outerOK);
        assertEq(result, abi.encodeWithSignature("Error(string)", "WBT transfer failed"));
        assertEq(target.calls(), 0);
        _assertUntouched(false);
    }

    function testFuzzGasHeavyCallsStayWithinSignedBudget(uint32 gasSeed) public {
        uint32 targetGas = uint32(bound(uint256(gasSeed), 100_000, 1_000_000));
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _intent(address(target), data, targetGas);
        uint256 budget = (uint256(targetGas) + 40_000) * PRICE;
        i.feeUSDT = (budget * router.usdtPerWBT() + 1e18 - 1) / 1e18;
        (bool outerOK, bool executed,) = _execute(i, data, uint256(targetGas) + 500_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(relayer.balance, budget);
        assertEq(tank.balanceOf(merchant), 1 ether - budget);
        (, uint256 spent) = tank.dailySpend(merchant);
        assertEq(spent, budget);
        assertEq(token.balanceOf(vault), i.feeUSDT);
    }

    function testHalfUSDTRefundRequiresExplicitMinimumAmountPolicyChange() public {
        bytes32 paymentId = keccak256("one-USDT-charge-half-USDT-refund");
        bytes memory data = abi.encodeCall(escrow.charge, (paymentId, merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(address(escrow), data, 400_000);
        (bool outerOK, bool executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);

        router.setAllowed(address(escrow), escrow.refund.selector, true, false);
        vm.prank(merchant);
        token.approve(address(escrow), type(uint256).max);
        data = abi.encodeCall(escrow.refund, (paymentId, 500_000, keccak256("customer-request")));
        i = _intent(address(escrow), data, 400_000);
        i.signer = merchant;
        i.amount = 500_000;
        i.nonce = 2;
        uint256 beforeTank = tank.balanceOf(merchant);
        uint256 beforeRelayer = relayer.balance;
        uint256 beforeFee = token.balanceOf(vault);
        _expectRefusal(i, Router.Refusal.Dust);
        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        assertFalse(router.usedNonces(merchant, 2));
        assertEq(tank.balanceOf(merchant), beforeTank);
        assertEq(relayer.balance, beforeRelayer);
        assertEq(token.balanceOf(vault), beforeFee);
        assertEq(token.balanceOf(payer), 9_000_000);

        // A deliberate owner policy change permits the same signed refund, with no redeployment.
        router.setLimits(500_000, 1_000_000, 10, 1_000_000, 100 gwei);
        (outerOK, executed,) = _execute(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 9_500_000);
        assertTrue(router.usedNonces(merchant, 2));
        (,,, uint256 captured, uint256 refunded,,,,) = escrow.payments(paymentId);
        assertEq(captured, 1_000_000);
        assertEq(refunded, 500_000);
    }
}
