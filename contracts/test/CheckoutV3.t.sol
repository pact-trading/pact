// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {FeeSchedule, IFeeSchedule} from "../src/FeeSchedule.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {Router} from "../src/Router.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {PactSuite} from "./utils/PactSuite.sol";
import {ReentrantUSDT} from "./mocks/ReentrantUSDT.sol";

/// @notice Records what the Router exposes to a target while its call runs.
contract ContextProbe {
    Router immutable router;
    address immutable merchant;
    address public seenSigner;
    address public seenMerchant;

    constructor(Router router_, address merchant_) {
        router = router_;
        merchant = merchant_;
    }

    function sponsorshipQuote(bytes calldata) external view returns (address, uint256) {
        return (merchant, 1_000_000);
    }

    function probe() external returns (bool) {
        seenSigner = router.activeSigner();
        seenMerchant = router.activeMerchant();
        return true;
    }
}

/// @notice v3 checkout: one-signature collectors (EIP-3009 and Permit2), packed payments, the Router's
/// bitmap nonces and transient context.
contract CheckoutV3Test is PactSuite {
    bytes32 constant ID = keccak256("payment-v3");

    function setUp() public {
        vm.warp(10 days);
        _deploy();
        token.mint(payer, 1_000_000_000);
        token.mint(merchant, 1_000_000_000);
    }

    function _collect(PaymentEscrow.Terms memory t, uint256 key) internal {
        (uint8 v, bytes32 r, bytes32 s) = _authorization(key, t, block.timestamp - 1, block.timestamp + 1 hours);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, block.timestamp - 1, block.timestamp + 1 hours, v, r, s);
    }

    // ------------------------------------------------------------------ EIP-3009 collector

    function testChargeWithAuthorizationNeedsOneSignatureAndNoAllowance() public {
        PaymentEscrow.Terms memory t = _terms(ID, 100_000_000, 0);
        assertEq(token.allowance(payer, address(escrow)), 0);
        uint256 fee = _checkoutFee(100_000_000);
        vm.expectEmit(true, true, true, true, address(escrow));
        emit PaymentEscrow.Charged(
            ID, payer, merchant, 100_000_000, fee, 0, uint64(block.timestamp + 1 days), 1 days, relayer
        );
        _collect(t, PAYER_KEY);
        assertEq(token.balanceOf(payer), 900_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 100_000_000 - fee);
        assertEq(token.balanceOf(relayer), fee);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertTrue(token.authorizationState(payer, escrow.authorizationNonce(t)));
        PaymentEscrow.PaymentView memory p = escrow.payment(ID);
        assertEq(p.payer, payer);
        assertEq(p.merchant, merchant);
        assertEq(p.authorized, 100_000_000);
        assertEq(p.captured, 100_000_000);
        assertEq(p.refunded, 0);
        assertTrue(p.closed);
        assertEq(p.product, 0);
        (uint64 deadline, uint32 window) = escrow.paymentTerms(ID);
        assertEq(deadline, block.timestamp + 1 days);
        assertEq(window, 1 days);
        // A collected payment refunds like any charge.
        vm.prank(merchant);
        token.approve(address(escrow), 40_000_000);
        vm.prank(merchant);
        escrow.refund(ID, 40_000_000, keccak256("partial"));
        assertEq(token.balanceOf(payer), 940_000_000);
        assertEq(escrow.payment(ID).refunded, 40_000_000);
    }

    function testInvoiceTermsUseTheInvoiceRate() public {
        token.mint(payer, 5_000_000_000);
        _collect(_terms(ID, 5_000_000_000, 1), PAYER_KEY);
        assertEq(token.balanceOf(relayer), 10_000_000);
        assertEq(escrow.payment(ID).product, 1);
    }

    function testAnAuthorizationPaysOnceAndOnlyItsOwnPayment() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        // The same signature under another payment id is another nonce: the token refuses it.
        PaymentEscrow.Terms memory next = _terms(keccak256("next"), 10_000_000, 0);
        vm.expectRevert("invalid signature");
        vm.prank(relayer);
        escrow.chargeWithAuthorization(next, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(token.balanceOf(payer), 990_000_000);
    }

    function testFuzzEveryTermIsBoundByTheSignature(uint8 field) public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        uint8 index = field % 6;
        if (index == 0) t.id = keccak256("other");
        if (index == 1) t.merchant = other;
        if (index == 2) t.amount = 10_000_001;
        if (index == 3) t.refundWindow = 2 days;
        if (index == 4) t.product = 1;
        if (index == 5) t.payer = merchant;
        vm.expectRevert("invalid signature");
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(token.balanceOf(payer), 1_000_000_000);
        assertEq(escrow.payment(t.id).payer, address(0));
    }

    function testAuthorizationCannotCrossEscrowOrChain() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        PaymentEscrow second =
            new PaymentEscrow(IERC20(address(token)), address(router), IFeeSchedule(address(fees)), permit2);
        vm.expectRevert("invalid signature");
        vm.prank(relayer);
        second.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        vm.chainId(block.chainid + 1);
        vm.expectRevert("invalid signature");
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
    }

    function testAuthorizationWindowIsEnforced() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        // Absolute times: via-IR may reuse an earlier TIMESTAMP read across warps.
        uint256 start = 10 days;
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, start + 10, start + 100);
        vm.expectRevert("authorization is not yet valid");
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, start + 10, start + 100, v, r, s);
        vm.warp(start + 100);
        vm.expectRevert("authorization is expired");
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, start + 10, start + 100, v, r, s);
        vm.warp(start + 50);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, start + 10, start + 100, v, r, s);
        assertEq(escrow.payment(ID).payer, payer);
    }

    function testAnyoneMaySubmitButTheMoneyOnlyGoesWhereSigned() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.prank(other);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(token.balanceOf(other), 0);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 10_000_000 - 150_000);
        // A third party cannot use the payer's authorization as a plain transfer to itself either:
        // receiveWithAuthorization only pays its signed payee, the escrow.
        vm.expectRevert("caller must be the payee");
        vm.prank(other);
        token.receiveWithAuthorization(payer, address(escrow), 10_000_000, 0, block.timestamp + 1 hours, bytes32(0), v, r, s);
    }

    function testInvalidTermsAreRefusedBeforeAnyTransfer() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        t.payer = address(0);
        vm.expectRevert(PaymentEscrow.InvalidTerms.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
        t = _terms(ID, 10_000_000, 2);
        vm.expectRevert(PaymentEscrow.InvalidTerms.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
        t = _terms(ID, 10_000_000, 0);
        t.merchant = address(0);
        vm.expectRevert(PaymentEscrow.InvalidTerms.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
        t = _terms(ID, 0, 0);
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
        t = _terms(ID, 10_000_000, 0);
        t.refundWindow = 0;
        vm.expectRevert(PaymentEscrow.InvalidAmount.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
        t = _terms(ID, uint256(type(uint64).max) + 1, 0);
        vm.expectRevert(PaymentEscrow.Overflow.selector);
        escrow.chargeWithAuthorization(t, 0, 1, 0, 0, 0);
    }

    function testAMerchantWithoutTermsOrADustPaymentRevertsAndKeepsTheAuthorization() public {
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        t.merchant = other;
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.expectRevert(FeeSchedule.TermsNotAccepted.selector);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        assertFalse(token.authorizationState(payer, escrow.authorizationNonce(t)));
        t = _terms(ID, 100_000, 0);
        (v, r, s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.expectRevert(FeeSchedule.FeeExceedsAmount.selector);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        assertEq(token.balanceOf(payer), 1_000_000_000);
    }

    function testACollectedIdCannotBeReusedByTheRouterPathAndViceVersa() public {
        _collect(_terms(ID, 10_000_000, 0), PAYER_KEY);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(payer);
        escrow.charge(ID, merchant, 10_000_000, 1 days);
        bytes32 routed = keccak256("routed");
        vm.prank(payer);
        escrow.charge(routed, merchant, 10_000_000, 1 days);
        PaymentEscrow.Terms memory t = _terms(routed, 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
    }

    // ------------------------------------------------------------------ Permit2 collector

    function _permit2Charge(PaymentEscrow.Terms memory t, uint256 nonce, bytes memory erc2612) internal {
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, nonce);
        bytes memory signature = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(t)));
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, erc2612);
    }

    function testChargeWithPermit2AfterAStandingApproval() public {
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);
        _permit2Charge(_terms(ID, 100_000_000, 0), 0, "");
        uint256 fee = _checkoutFee(100_000_000);
        assertEq(token.balanceOf(payer), 900_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000_000 + 100_000_000 - fee);
        assertEq(token.balanceOf(relayer), fee);
        assertEq(permit2.nonceBitmap(payer, 0), 1);
    }

    function testTheFirstPermit2PaymentCarriesItsOwnApproval() public {
        assertEq(token.allowance(payer, address(permit2)), 0);
        _permit2Charge(_terms(ID, 10_000_000, 0), 7, _erc2612(PAYER_KEY, address(permit2), type(uint256).max));
        assertEq(token.allowance(payer, address(permit2)), type(uint256).max);
        assertEq(token.balanceOf(payer), 990_000_000);
        // The next payment is one signature with nothing else.
        _permit2Charge(_terms(keccak256("second"), 10_000_000, 0), 8, "");
        assertEq(token.balanceOf(payer), 980_000_000);
    }

    function testAPermitSomeoneSubmittedFirstDoesNotBlockThePayment() public {
        bytes memory erc2612 = _erc2612(PAYER_KEY, address(permit2), type(uint256).max);
        (uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s) =
            abi.decode(erc2612, (uint256, uint256, uint8, bytes32, bytes32));
        vm.prank(other);
        token.permit(payer, address(permit2), value, deadline, v, r, s);
        _permit2Charge(_terms(ID, 10_000_000, 0), 0, erc2612);
        assertEq(token.balanceOf(payer), 990_000_000);
    }

    function testFuzzThePermit2WitnessBindsEveryTerm(uint8 field) public {
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        bytes memory signature = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(t)));
        uint8 index = field % 5;
        if (index == 0) t.id = keccak256("other");
        if (index == 1) t.merchant = other;
        if (index == 2) t.amount = 9_999_999;
        if (index == 3) t.refundWindow = 2 days;
        if (index == 4) t.product = 1;
        vm.expectRevert(); // Permit2 InvalidSigner
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, "");
        assertEq(token.balanceOf(payer), 1_000_000_000);
    }

    function testPermit2SignatureNamesThisEscrowAndOneNonce() public {
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        // Signed for another spender: refused here.
        bytes memory elsewhere = _sign(PAYER_KEY, _permit2Digest(permit, other, escrow.hashTerms(t)));
        vm.expectRevert();
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, elsewhere, "");
        _permit2Charge(t, 0, "");
        // Another payment signed with the same Permit2 nonce: Permit2 refuses the reused nonce.
        PaymentEscrow.Terms memory next = _terms(keccak256("next"), 10_000_000, 0);
        bytes memory reused = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(next)));
        vm.expectRevert(bytes4(keccak256("InvalidNonce()")));
        vm.prank(relayer);
        escrow.chargeWithPermit2(next, permit, reused, "");
    }

    function testPermit2MustMoveUsdtAtLeastTheAmount() public {
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);
        PaymentEscrow.Terms memory t = _terms(ID, 10_000_000, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        permit.permitted.token = address(0xDEAD);
        vm.expectRevert(PaymentEscrow.InvalidTerms.selector);
        escrow.chargeWithPermit2(t, permit, "", "");
        permit = _permit2Transfer(t.amount - 1, 0);
        bytes memory signature = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(t)));
        vm.expectRevert(); // Permit2 InvalidAmount: requested above permitted
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, "");
    }

    // ------------------------------------------------------------------ reentrancy

    function testAHostileTokenCannotReenterTheEscrow() public {
        ReentrantUSDT hostile = new ReentrantUSDT();
        (FeeSchedule f,, PaymentEscrow e,) =
            _deploySuite(IERC20(address(hostile)), relayer, keeper, USDT_PER_WBT, CANONICAL_PERMIT2);
        uint32 version = f.latestVersion();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory acceptance = _sign(MERCHANT_KEY, f.hashAcceptance(merchant, version, 0, deadline));
        f.acceptWithSig(merchant, version, deadline, acceptance);
        hostile.mint(payer, 100_000_000);
        vm.prank(payer);
        hostile.approve(address(e), type(uint256).max);
        hostile.arm(address(e), abi.encodeCall(e.charge, (keccak256("inner"), merchant, 10_000_000, 1 days)));
        vm.prank(payer);
        e.charge(ID, merchant, 10_000_000, 1 days);
        assertTrue(hostile.attempted());
        assertFalse(hostile.reentered());
        assertEq(bytes4(hostile.reentryResult()), ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        assertEq(e.payment(keccak256("inner")).payer, address(0));
    }

    // ------------------------------------------------------------------ Router v3

    function testBitmapNoncesShareAWordAndStillRefuseReplay() public {
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        for (uint256 n; n < 3; ++n) {
            bytes memory data = abi.encodeCall(escrow.charge, (bytes32(n + 1), merchant, 2_000_000, uint64(1 days)));
            assertTrue(_execute(_intent(payer, address(escrow), data, 2_000_000, n), data));
        }
        assertEq(router.nonceBitmap(payer, 0), 7); // bits 0, 1 and 2
        assertTrue(router.usedNonces(payer, 2));
        assertFalse(router.usedNonces(payer, 3));
        bytes memory again = abi.encodeCall(escrow.charge, (bytes32(uint256(9)), merchant, 2_000_000, uint64(1 days)));
        Router.Intent memory replay = _intent(payer, address(escrow), again, 2_000_000, 1);
        _expectRefusal(replay, Router.Refusal.Replay);
        assertFalse(_execute(replay, again));
        // Nonce 256 starts the next word.
        assertTrue(_execute(_intent(payer, address(escrow), again, 2_000_000, 256), again));
        assertEq(router.nonceBitmap(payer, 1), 1);
    }

    function testFuzzNoncesAreIndependent(uint256 a, uint256 b) public {
        vm.assume(a != b);
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        bytes memory data = abi.encodeCall(escrow.charge, (ID, merchant, 2_000_000, uint64(1 days)));
        assertTrue(_execute(_intent(payer, address(escrow), data, 2_000_000, a), data));
        assertTrue(router.usedNonces(payer, a));
        assertFalse(router.usedNonces(payer, b));
        assertFalse(router.usedNonces(merchant, a));
    }

    function testTheSignerAndMerchantAreVisibleOnlyDuringTheTargetCall() public {
        ContextProbe probe = new ContextProbe(router, merchant);
        router.setAllowed(address(probe), probe.probe.selector, true, true, false, false);
        bytes memory data = abi.encodeCall(probe.probe, ());
        assertTrue(_execute(_intent(payer, address(probe), data, 1_000_000, 5), data));
        assertEq(probe.seenSigner(), payer);
        assertEq(probe.seenMerchant(), merchant);
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
    }

    function testTheCachedDomainFollowsTheChain() public {
        bytes32 cached = router.domainSeparator();
        bytes32 typehash = keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
        assertEq(
            cached,
            keccak256(abi.encode(typehash, keccak256("Settle Router"), keccak256("2"), block.chainid, address(router)))
        );
        vm.chainId(block.chainid + 7);
        assertEq(
            router.domainSeparator(),
            keccak256(abi.encode(typehash, keccak256("Settle Router"), keccak256("2"), block.chainid, address(router)))
        );
        assertTrue(router.domainSeparator() != cached);
    }

    function testFeeScheduleQuotesFeeAndRecipientTogether() public view {
        (uint256 fee, address recipient) = fees.quote(merchant, 0, 100_000_000);
        assertEq(fee, fees.feeFor(merchant, 0, 100_000_000));
        assertEq(recipient, fees.recipient());
        (uint256 gasFee, address gasRecipient) = fees.gasQuote(1e15);
        assertEq(gasFee, fees.gasFee(1e15));
        assertEq(gasRecipient, relayer);
    }
}
