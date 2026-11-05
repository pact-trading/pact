// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {GasTank} from "../src/GasTank.sol";

contract RejectReimbursement {
    receive() external payable {
        revert("no WBT accepted");
    }
}

contract GasTankAccountingTest is Test {
    GasTank tank;
    address merchant = address(0xBEEF);
    address other = address(0xB0B);
    address relayer = address(0xCAFE);
    address router = address(0x1234);

    function setUp() public {
        vm.warp(10 days);
        tank = new GasTank();
        tank.setRouter(router);
        vm.deal(address(this), 2 ether);
        tank.deposit{value: 1 ether}(merchant);
        tank.deposit{value: 1 ether}(other);
        vm.prank(merchant);
        tank.setDailyCap(0.5 ether);
        vm.prank(other);
        tank.setDailyCap(1 ether);
    }

    function _pay(uint256 amount) internal {
        vm.prank(router);
        tank.reimburse(merchant, payable(relayer), amount);
    }

    function _assertAccounting(uint256 spent, uint256 balance) internal view {
        (, uint256 recorded) = tank.dailySpend(merchant);
        assertEq(recorded, spent);
        assertEq(tank.balanceOf(merchant), balance);
        assertEq(tank.balanceOf(other), 1 ether);
        (, uint256 otherSpent) = tank.dailySpend(other);
        assertEq(otherSpent, 0);
        assertEq(address(tank).balance, balance + 1 ether);
    }

    function testExactRemainingDailyCapAndOneWeiOver() public {
        _pay(0.2 ether);
        assertTrue(tank.canReimburse(merchant, 0.3 ether));
        assertFalse(tank.canReimburse(merchant, 0.3 ether + 1));
        vm.expectRevert(GasTank.DailyCapExceeded.selector);
        _pay(0.3 ether + 1);
        _assertAccounting(0.2 ether, 0.8 ether);
        _pay(0.3 ether);
        _assertAccounting(0.5 ether, 0.5 ether);
        assertEq(relayer.balance, 0.5 ether);
        assertFalse(tank.canReimburse(merchant, 1));
    }

    function testExactBalanceAndOneWeiOverCannotUseOtherMerchantTank() public {
        vm.prank(merchant);
        tank.setDailyCap(2 ether);
        assertTrue(tank.canReimburse(merchant, 1 ether));
        assertFalse(tank.canReimburse(merchant, 1 ether + 1));
        vm.expectRevert(GasTank.InsufficientTank.selector);
        _pay(1 ether + 1);
        _pay(1 ether);
        _assertAccounting(1 ether, 0);
        assertEq(relayer.balance, 1 ether);
    }

    function testLoweringCapBelowSpendDoesNotUnderflowAndNextDayResetsSpend() public {
        _pay(0.4 ether);
        vm.prank(merchant);
        tank.setDailyCap(0.1 ether);
        assertFalse(tank.canReimburse(merchant, 1));
        vm.expectRevert(GasTank.DailyCapExceeded.selector);
        _pay(1);
        vm.warp(11 days - 1);
        assertFalse(tank.canReimburse(merchant, 1));
        vm.warp(11 days);
        assertTrue(tank.canReimburse(merchant, 0.1 ether));
        _pay(0.1 ether);
        _assertAccounting(0.1 ether, 0.5 ether);
        (uint64 day,) = tank.dailySpend(merchant);
        assertEq(day, 11);
        assertEq(relayer.balance, 0.5 ether);
    }

    function testZeroCapDisablesEvenZeroReimbursement() public {
        vm.prank(merchant);
        tank.setDailyCap(0);
        assertFalse(tank.canReimburse(merchant, 0));
        vm.expectRevert(GasTank.DailyCapExceeded.selector);
        _pay(0);
        _assertAccounting(0, 1 ether);
    }

    function testRelayerTransferFailureRollsBackBalanceAndSpend() public {
        RejectReimbursement rejector = new RejectReimbursement();
        vm.expectRevert(bytes("WBT transfer failed"));
        vm.prank(router);
        tank.reimburse(merchant, payable(address(rejector)), 0.1 ether);
        _assertAccounting(0, 1 ether);
        assertEq(address(rejector).balance, 0);
        (uint64 day,) = tank.dailySpend(merchant);
        assertEq(day, 0);
    }

    function testWithdrawAndDepositDoNotResetDailySpend() public {
        _pay(0.2 ether);
        vm.prank(merchant);
        tank.withdraw(0.8 ether);
        _assertAccounting(0.2 ether, 0);
        vm.prank(merchant);
        tank.deposit{value: 0.8 ether}(merchant);
        _assertAccounting(0.2 ether, 0.8 ether);
        assertFalse(tank.canReimburse(merchant, 0.3 ether + 1));
    }

    function testRouterBindingCannotBeReplacedOrBypassed() public {
        vm.expectRevert(GasTank.NotAuthorized.selector);
        tank.setRouter(address(this));
        vm.expectRevert(GasTank.NotAuthorized.selector);
        tank.reimburse(merchant, payable(relayer), 1);
        _assertAccounting(0, 1 ether);
    }

    function testFuzzReimbursementConservesMerchantBalances(uint96 firstSeed, uint96 secondSeed) public {
        uint256 first = bound(firstSeed, 0, 0.5 ether);
        uint256 second = bound(secondSeed, 0, 0.5 ether - first);
        _pay(first);
        _pay(second);
        uint256 paid = first + second;
        _assertAccounting(paid, 1 ether - paid);
        assertEq(relayer.balance, paid);
        assertTrue(tank.canReimburse(merchant, 0.5 ether - paid));
        assertFalse(tank.canReimburse(merchant, 0.5 ether - paid + 1));
    }
}
