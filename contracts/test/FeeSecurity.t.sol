// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeSchedule} from "../src/FeeSchedule.sol";
import {Router} from "../src/Router.sol";
import {PactSuite} from "./utils/PactSuite.sol";

/// @notice The fee cannot be chosen by whoever signs, and a merchant's allowances are spent only on
/// calls the merchant signed.
contract FeeSecurityTest is PactSuite {
    uint256 constant ATTACKER_KEY = 0xA77AC;
    address attacker;

    function setUp() public {
        vm.warp(10 days);
        _deploy();
        attacker = vm.addr(ATTACKER_KEY);
        token.mint(attacker, 10_000_000);
        token.mint(merchant, 1_000_000_000);
        vm.prank(attacker);
        token.approve(address(escrow), type(uint256).max);
        // The merchant approved everything without limit, as wallet setup used to.
        vm.startPrank(merchant);
        token.approve(address(router), type(uint256).max);
        token.approve(address(escrow), type(uint256).max);
        vm.stopPrank();
    }

    function _signedBy(uint256 key, Router.Intent memory i) internal view returns (bytes memory) {
        return _sign(key, router.hashIntent(i));
    }

    /// The old drain: a payer signed a 1 USDT charge with a fee as large as the merchant's balance and
    /// submitted it itself. The intent no longer carries a fee, so the merchant only ever receives money.
    function testASignerCannotMakeTheMerchantPayAnyFee() public {
        uint256 merchantBefore = token.balanceOf(merchant);
        bytes memory data = abi.encodeCall(escrow.charge, (keccak256("drain"), merchant, 1_000_000, uint64(1 days)));
        Router.Intent memory i = Router.Intent(
            attacker,
            merchant,
            address(escrow),
            keccak256(data),
            1_000_000,
            1,
            uint64(block.timestamp + 1 hours),
            500_000
        );
        vm.prank(attacker);
        (bool ok,) = router.execute(i, data, _signedBy(ATTACKER_KEY, i));
        assertTrue(ok);
        assertEq(token.balanceOf(merchant), merchantBefore + 1_000_000 - 150_000);
        assertEq(token.balanceOf(relayer), 150_000);
        assertEq(token.allowance(merchant, address(router)), type(uint256).max);
    }

    /// Gas-charged calls must be signed by the merchant they charge: nobody else can name it.
    function testOnlyTheMerchantCanSignACallThatChargesIt() public {
        vm.prank(attacker);
        escrow.charge(keccak256("bought"), merchant, 5_000_000, uint64(1 days));
        bytes memory data = abi.encodeCall(escrow.refund, (keccak256("bought"), 5_000_000, bytes32(0)));
        Router.Intent memory i = Router.Intent(
            attacker,
            merchant,
            address(escrow),
            keccak256(data),
            5_000_000,
            1,
            uint64(block.timestamp + 1 hours),
            1_000_000
        );
        uint256 merchantBefore = token.balanceOf(merchant);
        _expectRefusal(i, Router.Refusal.SignerNotMerchant);
        vm.prank(attacker);
        (bool ok,) = router.execute(i, data, _signedBy(ATTACKER_KEY, i));
        assertFalse(ok);
        assertEq(token.balanceOf(merchant), merchantBefore);
        assertEq(token.balanceOf(attacker), 5_000_000);
    }

    /// Even the merchant's own gas-charged call cannot cost more than the ceiling its signed gas sets,
    /// whatever gas price the submitter pays up to the Router's cap.
    function testTheGasChargeIsBoundedByTheSignedGasAndTheGasPriceCap() public {
        vm.prank(attacker);
        escrow.charge(keccak256("bought"), merchant, 5_000_000, uint64(1 days));
        bytes memory data = abi.encodeCall(escrow.refund, (keccak256("bought"), 5_000_000, bytes32(0)));
        Router.Intent memory i = Router.Intent(
            merchant,
            merchant,
            address(escrow),
            keccak256(data),
            5_000_000,
            1,
            uint64(block.timestamp + 1 hours),
            300_000
        );
        bytes memory signature = _signedBy(MERCHANT_KEY, i);
        vm.txGasPrice(101 gwei);
        _expectRefusal(i, Router.Refusal.GasPrice);
        vm.prank(attacker);
        (bool ok,) = router.execute(i, data, signature);
        assertFalse(ok);
        vm.txGasPrice(100 gwei);
        uint256 relayerBefore = token.balanceOf(relayer);
        vm.prank(attacker);
        (ok,) = router.execute(i, data, signature);
        assertTrue(ok);
        uint256 charged = token.balanceOf(relayer) - relayerBefore;
        // (300,000 + 60,000) gas at 100 gwei, at 79 USDT per WBT, is 2.844 USDT at most.
        assertLe(charged, router.maxGasFee(300_000, 100 gwei));
        assertEq(router.maxGasFee(300_000, 100 gwei), 2_844_000);
        // The submitter (here also the refunded payer) gets its refund and nothing more: the gas
        // charge goes to Pact's recipient, not to whoever sent the transaction.
        assertEq(token.balanceOf(attacker), 10_000_000);
    }

    /// Pact cannot raise a merchant's fee by publishing terms the merchant did not sign.
    function testPublishedTermsDoNotReachAMerchantUntilItSigns() public {
        fees.publish(FeeSchedule.Terms(FeeSchedule.Rate(500, 1_000_000, 0), FeeSchedule.Rate(500, 1_000_000, 0)));
        uint256 merchantBefore = token.balanceOf(merchant);
        vm.prank(attacker);
        escrow.charge(keccak256("after-publish"), merchant, 10_000_000, uint64(1 days));
        assertEq(token.balanceOf(merchant), merchantBefore + 10_000_000 - 150_000);
    }

    /// A merchant that never accepted terms cannot be charged a fee at all: payments to it fail.
    function testNoTermsNoPayment() public {
        address stranger = address(0x5757);
        vm.expectRevert(FeeSchedule.TermsNotAccepted.selector);
        vm.prank(attacker);
        escrow.charge(keccak256("stranger"), stranger, 10_000_000, uint64(1 days));
        assertEq(token.balanceOf(attacker), 10_000_000);
    }

    /// A leaked keeper key moves the gas price at most 20% every 10 minutes; only the owner can jump it.
    function testALeakedKeeperCannotJumpTheGasPrice() public {
        vm.warp(block.timestamp + 10 minutes);
        vm.expectRevert(FeeSchedule.PriceStepTooLarge.selector);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 10);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 6 / 5);
        vm.expectRevert(FeeSchedule.PriceTooSoon.selector);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 36 / 25);
    }
}
