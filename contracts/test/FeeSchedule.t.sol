// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {FeeSchedule} from "../src/FeeSchedule.sol";
import {PactSuite} from "./utils/PactSuite.sol";

contract FeeScheduleTest is PactSuite {
    uint256 constant NEWCOMER_KEY = 0xC0FFEE;

    function setUp() public {
        vm.warp(10 days);
        _deploy();
    }

    function _terms(uint16 checkoutBps, uint64 min, uint64 invoiceCap)
        internal
        pure
        returns (FeeSchedule.Terms memory)
    {
        return FeeSchedule.Terms(FeeSchedule.Rate(checkoutBps, min, 0), FeeSchedule.Rate(50, min, invoiceCap));
    }

    function testDeploymentPublishesTheStartingRatesAndRoles() public view {
        assertEq(fees.latestVersion(), 1);
        assertEq(fees.owner(), address(this));
        assertEq(fees.recipient(), relayer);
        assertEq(fees.priceKeeper(), relayer);
        assertEq(fees.usdtPerWBT(), USDT_PER_WBT);
        FeeSchedule.Terms memory t = fees.terms(1);
        assertEq(t.checkout.bps, 80);
        assertEq(t.checkout.minFee, 150_000);
        assertEq(t.checkout.maxFee, 0);
        assertEq(t.invoice.bps, 50);
        assertEq(t.invoice.minFee, 150_000);
        assertEq(t.invoice.maxFee, 10_000_000);
        assertEq(fees.acceptedVersion(merchant), 1);
    }

    function testFeesFollowRateFloorAndCap() public view {
        // 0.8% of 100 USDT; the 0.15 USDT floor below 18.75 USDT.
        assertEq(fees.feeFor(merchant, 0, 100_000_000), 800_000);
        assertEq(fees.feeFor(merchant, 0, 10_000_000), 150_000);
        assertEq(fees.feeFor(merchant, 0, 1_000_000), 150_000);
        // Rounded up: 0.8% of 1,000,001 base units is 8,000.008.
        assertEq(fees.feeFor(merchant, 0, 1_000_000_001), 8_000_001);
        // 0.5% of invoices, capped at 10 USDT from 2,000 USDT.
        assertEq(fees.feeFor(merchant, 1, 1_000_000_000), 5_000_000);
        assertEq(fees.feeFor(merchant, 1, 2_000_000_000), 10_000_000);
        assertEq(fees.feeFor(merchant, 1, 50_000_000_000), 10_000_000);
        assertEq(fees.feeFor(merchant, 1, 1_000_000), 150_000);
    }

    function testFeeNeverExceedsThePaymentAndUnknownProductsAreRefused() public {
        vm.expectRevert(FeeSchedule.FeeExceedsAmount.selector);
        fees.feeFor(merchant, 0, 149_999);
        assertEq(fees.feeFor(merchant, 0, 150_000), 150_000);
        vm.expectRevert(FeeSchedule.InvalidProduct.selector);
        fees.feeFor(merchant, 2, 100_000_000);
    }

    function testAMerchantWithoutAcceptedTermsCannotBeCharged() public {
        address newcomer = vm.addr(NEWCOMER_KEY);
        vm.expectRevert(FeeSchedule.TermsNotAccepted.selector);
        fees.feeFor(newcomer, 0, 100_000_000);
        vm.prank(newcomer);
        fees.accept(1);
        assertEq(fees.feeFor(newcomer, 0, 100_000_000), 800_000);
    }

    function testSignedAcceptanceIsBoundToMerchantVersionNonceAndDeadline() public {
        address newcomer = vm.addr(NEWCOMER_KEY);
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(NEWCOMER_KEY, fees.hashAcceptance(newcomer, 1, 0, deadline));
        // Another account cannot use it, nor can a different deadline.
        vm.expectRevert(FeeSchedule.InvalidSignature.selector);
        fees.acceptWithSig(merchant, 1, deadline, signature);
        vm.expectRevert(FeeSchedule.InvalidSignature.selector);
        fees.acceptWithSig(newcomer, 1, deadline + 1, signature);
        vm.prank(relayer);
        fees.acceptWithSig(newcomer, 1, deadline, signature);
        assertEq(fees.acceptedVersion(newcomer), 1);
        assertEq(fees.nonces(newcomer), 1);
        // Replay: the nonce moved on.
        vm.expectRevert(FeeSchedule.InvalidSignature.selector);
        fees.acceptWithSig(newcomer, 1, deadline, signature);
        vm.warp(deadline + 1);
        vm.expectRevert(FeeSchedule.SignatureExpired.selector);
        fees.acceptWithSig(newcomer, 1, deadline, signature);
    }

    function testNewTermsApplyOnlyOnceTheMerchantAcceptsThem() public {
        uint32 version = fees.publish(_terms(200, 500_000, 20_000_000));
        assertEq(version, 2);
        // The merchant is still on version 1, and only the latest version can be accepted.
        assertEq(fees.feeFor(merchant, 0, 100_000_000), 800_000);
        vm.expectRevert(FeeSchedule.UnknownVersion.selector);
        vm.prank(merchant);
        fees.accept(1);
        vm.expectRevert(FeeSchedule.UnknownVersion.selector);
        vm.prank(merchant);
        fees.accept(3);
        _acceptTerms(MERCHANT_KEY);
        assertEq(fees.acceptedVersion(merchant), 2);
        assertEq(fees.feeFor(merchant, 0, 100_000_000), 2_000_000);
    }

    function testPublishedTermsAreBounded() public {
        vm.expectRevert(FeeSchedule.InvalidTerms.selector);
        fees.publish(_terms(501, 150_000, 0));
        vm.expectRevert(FeeSchedule.InvalidTerms.selector);
        fees.publish(_terms(80, 1_000_001, 0));
        vm.expectRevert(FeeSchedule.InvalidTerms.selector);
        fees.publish(_terms(80, 150_000, 100_000));
        vm.expectRevert(FeeSchedule.NotOwner.selector);
        vm.prank(other);
        fees.publish(_terms(80, 150_000, 0));
        vm.expectRevert(FeeSchedule.UnknownVersion.selector);
        fees.terms(2);
    }

    function testGasFeeRoundsUpAtTheCurrentPrice() public view {
        // 200,000 gas at 1 gwei is 0.0002 WBT, 0.0158 USDT at 79 USDT per WBT.
        assertEq(fees.gasFee(200_000 * PRICE), 15_800);
        assertEq(fees.gasFee(1), 1);
        assertEq(fees.gasFee(0), 0);
    }

    function testTheKeeperMovesThePriceInBoundedSteps() public {
        vm.expectRevert(FeeSchedule.PriceTooSoon.selector);
        vm.prank(relayer);
        fees.setPrice(80_000_000);
        vm.warp(block.timestamp + 10 minutes);
        vm.expectRevert(FeeSchedule.PriceStepTooLarge.selector);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 12_001 / 10_000);
        vm.expectRevert(FeeSchedule.PriceStepTooLarge.selector);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 7_999 / 10_000);
        vm.prank(relayer);
        fees.setPrice(USDT_PER_WBT * 12 / 10);
        assertEq(fees.usdtPerWBT(), 94_800_000);
        vm.expectRevert(FeeSchedule.NotAuthorized.selector);
        vm.prank(other);
        fees.setPrice(94_800_000);
        vm.expectRevert(FeeSchedule.InvalidPrice.selector);
        fees.setPrice(0);
        // The owner can correct the price at once, in any step.
        fees.setPrice(1_000_000);
        assertEq(fees.usdtPerWBT(), 1_000_000);
    }

    function testRecipientKeeperAndOwnershipAreOwnerControlled() public {
        address vault = address(0xFEE);
        vm.expectRevert(FeeSchedule.NotOwner.selector);
        vm.prank(other);
        fees.setRecipient(vault);
        vm.expectRevert(FeeSchedule.InvalidAddress.selector);
        fees.setRecipient(address(0));
        fees.setRecipient(vault);
        assertEq(fees.recipient(), vault);
        fees.setPriceKeeper(address(0));
        vm.warp(block.timestamp + 1 hours);
        vm.expectRevert(FeeSchedule.NotAuthorized.selector);
        vm.prank(relayer);
        fees.setPrice(80_000_000);
        fees.transferOwnership(other);
        assertEq(fees.owner(), address(this));
        vm.expectRevert(FeeSchedule.NotAuthorized.selector);
        vm.prank(relayer);
        fees.acceptOwnership();
        vm.prank(other);
        fees.acceptOwnership();
        assertEq(fees.owner(), other);
        vm.expectRevert(FeeSchedule.NotOwner.selector);
        fees.setRecipient(relayer);
    }

    function testFuzzFeeStaysWithinTheRate(uint96 amountSeed, uint16 bpsSeed, uint64 minSeed, uint64 capSeed) public {
        uint16 bps = uint16(bound(bpsSeed, 0, 500));
        uint64 min = uint64(bound(minSeed, 0, 1_000_000));
        uint64 cap = uint64(bound(capSeed, 0, 50_000_000));
        if (cap != 0 && cap < min) cap = min;
        fees.publish(FeeSchedule.Terms(FeeSchedule.Rate(bps, min, cap), FeeSchedule.Rate(bps, min, cap)));
        _acceptTerms(MERCHANT_KEY);
        uint256 amount = bound(amountSeed, 1_000_000, 10_000_000_000_000);
        uint256 fee = fees.feeFor(merchant, 0, amount);
        assertLe(fee, amount);
        assertGe(fee, min);
        if (cap != 0) assertLe(fee, cap);
        else assertGe(fee, (amount * bps) / 10_000);
    }
}
