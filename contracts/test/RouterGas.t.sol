// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Router} from "../src/Router.sol";
import {PactSuite} from "./utils/PactSuite.sol";

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

/// @notice The gas budgets the API signs and sends with, and the gas the Router charges in USDT.
contract RouterGasTest is PactSuite {
    GasTestTarget target;

    function setUp() public {
        vm.warp(10 days);
        _deploy();
        target = new GasTestTarget(merchant);
        // Every target call here is a merchant-paid, gas-charged call, like a refund.
        router.setAllowed(address(target), target.burn.selector, true, true, true, true);
        router.setAllowed(address(target), target.refuse.selector, true, true, true, true);
        router.setAllowed(address(target), target.fail.selector, true, false, true, true);
        router.setAllowed(address(target), target.requireGas.selector, true, true, true, true);
        token.mint(payer, 10_000_000);
        token.mint(merchant, 10_000_000);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(router), type(uint256).max);
        vm.prank(merchant);
        token.approve(address(escrow), type(uint256).max);
    }

    function _gasIntent(address to, bytes memory data, uint32 maxGas) internal view returns (Router.Intent memory i) {
        i = _intent(merchant, to, data, 1_000_000, 1);
        i.maxGas = maxGas;
    }

    function _call(Router.Intent memory i, bytes memory data, uint256 gasLimit)
        internal
        returns (bool outerOK, bool executed, bytes memory result)
    {
        bytes memory payload = abi.encodeCall(router.execute, (i, data, _sign(_keyFor(i.signer), router.hashIntent(i))));
        vm.prank(relayer);
        (outerOK, result) = address(router).call{gas: gasLimit}(payload);
        if (outerOK) (executed, result) = abi.decode(result, (bool, bytes));
    }

    function _assertUntouched(address signer, bool consumed) internal view {
        assertEq(router.usedNonces(signer, 1), consumed);
        (, uint32 count) = router.payerDaily(signer);
        assertEq(count, consumed ? 1 : 0);
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
        assertEq(token.balanceOf(relayer), 0);
        assertEq(token.balanceOf(payer), 10_000_000);
        assertEq(token.balanceOf(merchant), 10_000_000);
    }

    function testInsufficientOuterGasReturnsGasLimitAndSameSignatureCanRetry() public {
        bytes memory data = abi.encodeCall(escrow.charge, (keccak256("gas"), merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(payer, address(escrow), data, 1_000_000, 1);
        _expectRefusal(i, Router.Refusal.GasLimit);
        (bool outerOK, bool executed, bytes memory result) = _call(i, data, 150_000);
        assertTrue(outerOK, "a successful EVM call can be a business refusal");
        assertFalse(executed);
        assertEq(result.length, 0);
        _assertUntouched(payer, false);

        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertTrue(router.usedNonces(payer, i.nonce));
        assertEq(token.balanceOf(payer), 9_000_000);
        assertEq(token.balanceOf(merchant), 11_000_000 - 150_000);
        assertEq(token.balanceOf(relayer), 150_000);
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
        Router.Intent memory i = _intent(merchant, address(escrow), data, 1_000_000, 1);
        i.maxGas = 400_000;
        uint256 allowance = vm.envOr("API_REFUND_EXECUTION_GAS", uint256(i.maxGas) + uint256(i.maxGas) / 63 + 320_000);
        (bool outerOK, bool executed,) = _call(i, data, allowance);
        assertTrue(outerOK, "API refund gas budget cannot pass Router forwarding guard");
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 10_000_000);
        assertGt(token.balanceOf(relayer), 150_000, "the refund's gas is charged on top of the original fee");
    }

    function _assertApiCharge(uint32 maxGas, string memory envKey) internal {
        bytes memory data = abi.encodeCall(escrow.charge, (keccak256("api-gas"), merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(payer, address(escrow), data, 1_000_000, 1);
        i.maxGas = maxGas;
        // The API adds intrinsic calldata gas separately; this is the execution allowance.
        uint256 allowance = vm.envOr(envKey, uint256(maxGas) + uint256(maxGas) / 63 + 320_000);
        (bool outerOK, bool executed,) = _call(i, data, allowance);
        assertTrue(outerOK, "API gas budget cannot pass Router forwarding guard");
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 9_000_000);
    }

    function testExtremelyLowOuterGasRevertsAndRollsBack() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _gasIntent(address(target), data, 500_000);
        (bool outerOK,,) = _call(i, data, 5_000);
        assertFalse(outerOK);
        _assertUntouched(merchant, false);
    }

    function testZeroAndAbovePolicyMaxGasRefuseEvenWithEnoughOuterGas() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _gasIntent(address(target), data, 0);
        _expectRefusal(i, Router.Refusal.GasLimit);
        (bool outerOK, bool executed,) = _call(i, data, 2_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        i.maxGas = router.maxGasPerCall() + 1;
        _expectRefusal(i, Router.Refusal.GasLimit);
        (outerOK, executed,) = _call(i, data, 2_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(merchant, false);
    }

    function testTargetRevertConsumesNonceAndDailyCountWithoutCharging() public {
        bytes memory data = abi.encodeCall(target.fail, ());
        Router.Intent memory i = _gasIntent(address(target), data, 500_000);
        _expectRefusal(i, Router.Refusal.TargetFailed);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(merchant, true);
        _expectRefusal(i, Router.Refusal.Replay);
        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(merchant, true);
    }

    function testTargetFalseConsumesNonceAndDailyCountWithoutCharging() public {
        bytes memory data = abi.encodeCall(target.refuse, ());
        Router.Intent memory i = _gasIntent(address(target), data, 500_000);
        _expectRefusal(i, Router.Refusal.TargetRefused);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(merchant, true);
    }

    function testTargetOutOfGasConsumesNonceButDoesNotCharge() public {
        bytes memory data = abi.encodeCall(target.burn, (0));
        Router.Intent memory i = _gasIntent(address(target), data, 200_000);
        _expectRefusal(i, Router.Refusal.TargetFailed);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        assertEq(target.calls(), 0);
        _assertUntouched(merchant, true);
    }

    function testGasChargeCannotExceedTheCeiling() public {
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _gasIntent(address(target), data, 200_000);
        uint256 ceiling = router.maxGasFee(i.maxGas, PRICE);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(token.balanceOf(relayer), ceiling, "a call that burns its whole allowance pays exactly the ceiling");
        assertEq(token.balanceOf(merchant), 10_000_000 - ceiling);
    }

    function testExactCeilingAllowanceCanPayAGasHeavySuccess() public {
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _gasIntent(address(target), data, 200_000);
        uint256 ceiling = router.maxGasFee(i.maxGas, PRICE);
        vm.prank(merchant);
        token.approve(address(router), ceiling);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK, "preflight accepted a ceiling that settlement exceeded");
        assertTrue(executed);
        assertEq(target.calls(), 1);
        assertEq(token.allowance(merchant, address(router)), 0);
        assertEq(token.balanceOf(relayer), ceiling);
    }

    function testGasLostAfterEarlyGuardMustNotConsumeIntent() public {
        bytes memory data = abi.encodeCall(target.requireGas, (490_000));
        Router.Intent memory i = _gasIntent(address(target), data, 500_000);
        (bool outerOK,, bytes memory result) = _call(i, data, 620_000);
        assertFalse(outerOK, "insufficient forwarding or settlement gas must roll back");
        assertEq(result, abi.encodeWithSignature("InsufficientExecutionGas()"));
        _assertUntouched(merchant, false);
        assertEq(target.calls(), 0);
        bool executed;
        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
    }

    function testCeilingRoundsUpAndOneUnitUnderRefusesWithoutConsumingNonce() public {
        vm.txGasPrice(PRICE + 1);
        bytes memory data = abi.encodeCall(target.requireGas, (1));
        Router.Intent memory i = _gasIntent(address(target), data, 200_000);
        uint256 wbt = (uint256(i.maxGas) + router.GAS_OVERHEAD()) * (PRICE + 1);
        uint256 ceiling = (wbt * USDT_PER_WBT + 1e18 - 1) / 1e18;
        assertEq(router.maxGasFee(i.maxGas, PRICE + 1), ceiling);
        assertEq(ceiling, 20_541);
        vm.prank(merchant);
        token.approve(address(router), ceiling - 1);
        _expectRefusal(i, Router.Refusal.FeeUnavailable);
        (bool outerOK, bool executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        _assertUntouched(merchant, false);
        vm.prank(merchant);
        token.approve(address(router), ceiling);
        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertGt(token.balanceOf(relayer), 0);
        assertLe(token.balanceOf(relayer), ceiling);
    }

    function testGasFeeTransferFailureRollsBackTargetAndNonce() public {
        bytes memory data = abi.encodeCall(target.burn, (150_000));
        Router.Intent memory i = _gasIntent(address(target), data, 200_000);
        // The token fails every transfer: the call's gas cannot be paid, so nothing it did may stand.
        token.setFailTransfers(true);
        (bool outerOK,,) = _call(i, data, 1_000_000);
        assertFalse(outerOK);
        assertEq(target.calls(), 0);
        token.setFailTransfers(false);
        _assertUntouched(merchant, false);
    }

    function testFuzzGasHeavyCallsStayWithinTheCeiling(uint32 gasSeed) public {
        uint32 targetGas = uint32(bound(uint256(gasSeed), 100_000, 1_000_000));
        bytes memory data = abi.encodeCall(target.burn, (5_000));
        Router.Intent memory i = _gasIntent(address(target), data, targetGas);
        uint256 ceiling = router.maxGasFee(targetGas, PRICE);
        (bool outerOK, bool executed,) = _call(i, data, uint256(targetGas) + 500_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(token.balanceOf(relayer), ceiling);
        assertEq(token.balanceOf(merchant), 10_000_000 - ceiling);
    }

    function testHalfUSDTRefundRequiresExplicitMinimumAmountPolicyChange() public {
        bytes32 paymentId = keccak256("one-USDT-charge-half-USDT-refund");
        bytes memory data = abi.encodeCall(escrow.charge, (paymentId, merchant, 1_000_000, uint64(1 days)));
        (bool outerOK, bool executed,) = _call(_intent(payer, address(escrow), data, 1_000_000, 1), data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);

        data = abi.encodeCall(escrow.refund, (paymentId, 500_000, keccak256("customer-request")));
        Router.Intent memory i = _intent(merchant, address(escrow), data, 500_000, 2);
        uint256 beforeRelayer = token.balanceOf(relayer);
        _expectRefusal(i, Router.Refusal.Dust);
        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertFalse(executed);
        assertFalse(router.usedNonces(merchant, 2));
        assertEq(token.balanceOf(relayer), beforeRelayer);
        assertEq(token.balanceOf(payer), 9_000_000);

        // A deliberate owner policy change permits the same signed refund, with no redeployment.
        router.setLimits(500_000, 10, 1_000_000, 100 gwei);
        (outerOK, executed,) = _call(i, data, 1_000_000);
        assertTrue(outerOK);
        assertTrue(executed);
        assertEq(token.balanceOf(payer), 9_500_000);
        assertTrue(router.usedNonces(merchant, 2));
        (,,, uint256 captured, uint256 refunded,,,,) = escrow.payments(paymentId);
        assertEq(captured, 1_000_000);
        assertEq(refunded, 500_000);
    }
}
