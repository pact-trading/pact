// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSchedule, IFeeSchedule} from "../src/FeeSchedule.sol";
import {Router} from "../src/Router.sol";
import {InvestorRegistry} from "../src/InvestorRegistry.sol";
import {InvoiceReceivables, IInvestorRegistry} from "../src/InvoiceReceivables.sol";
import {BlockingUSDT} from "./mocks/BlockingUSDT.sol";

/// @notice A minimal ERC-1271 wallet: it accepts the digests its owner allowed.
contract SmartAccount {
    mapping(bytes32 => bool) public allowed;

    function allow(bytes32 digest) external {
        allowed[digest] = true;
    }

    function approve(BlockingUSDT token, address spender) external {
        token.approve(spender, type(uint256).max);
    }

    function isValidSignature(bytes32 digest, bytes calldata) external view returns (bytes4) {
        return allowed[digest] ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
}

contract InvoiceReceivablesTest is Test {
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant USDT = 1e6;
    uint256 constant FACE = 1_000 * USDT;
    /// The contract's invoice reference for "inv_1": the hash of the API's invoice id.
    bytes32 constant INVOICE = keccak256("inv_1");
    uint256 constant ALICE_KEY = 0xA1A1;
    uint256 constant BOB_KEY = 0xB0B0;
    uint256 constant OFFICER_KEY = 0x0FF1CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;

    BlockingUSDT token;
    FeeSchedule fees;
    Router router;
    InvestorRegistry registry;
    InvoiceReceivables market;

    address payer;
    address merchant = vm.addr(MERCHANT_KEY);
    /// Where every fee goes: Pact's relayer today.
    address feeVault = address(0xFEE);
    address officer = vm.addr(OFFICER_KEY);
    address alice = vm.addr(ALICE_KEY);
    address bob = vm.addr(BOB_KEY);
    address carol = address(0xCA401);
    address outsider = address(0xBAD);
    uint64 maturity;

    receive() external payable {}

    function setUp() public {
        vm.warp(1_800_000_000);
        payer = vm.addr(PAYER_KEY);
        token = new BlockingUSDT();
        fees = new FeeSchedule(
            feeVault,
            address(this),
            79_000_000,
            FeeSchedule.Terms(FeeSchedule.Rate(80, 150_000, 0), FeeSchedule.Rate(50, 150_000, 10_000_000))
        );
        router = new Router(IERC20(address(token)), IFeeSchedule(address(fees)));
        registry = new InvestorRegistry(address(this));
        registry.setOfficer(officer, true);
        market = new InvoiceReceivables(_config());
        router.setAllowed(address(market), market.pay.selector, true, false, false, true);
        router.setAllowed(address(market), market.buyBack.selector, true, false, true, false);
        vm.prank(merchant);
        fees.accept(1);

        for (uint256 i; i < 3; i++) {
            address who = [alice, bob, carol][i];
            token.mint(who, 10_000 * USDT);
            vm.prank(who);
            token.approve(address(market), type(uint256).max);
            vm.prank(officer);
            registry.approve(who, uint64(block.timestamp + 365 days), "GB");
        }
        token.mint(payer, 10_000 * USDT);
        vm.prank(payer);
        token.approve(address(market), type(uint256).max);
        token.mint(merchant, 10_000 * USDT);
        vm.startPrank(merchant);
        token.approve(address(market), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
        vm.txGasPrice(1 gwei);
        maturity = uint64(block.timestamp + 30 days);
    }

    function _config() internal view returns (InvoiceReceivables.Config memory) {
        return InvoiceReceivables.Config({
            usdt: IERC20(address(token)),
            router: address(router),
            registry: IInvestorRegistry(address(registry)),
            fees: IFeeSchedule(address(fees)),
            feeBps: 50,
            reserveBps: 1_000,
            lateFeeBps: 100,
            maxDiscountBps: 2_000,
            gracePeriod: 7 days,
            recordPeriod: 1 days,
            minShare: USDT,
            maxHolders: 8,
            predecessors: new address[](0)
        });
    }

    // ---------------------------------------------------------------- helpers

    function _list(uint16 discountBps) internal returns (uint256 id) {
        return _listAs("inv_1", FACE, maturity, discountBps);
    }

    /// The customer (the payer) signs the acknowledgement the API asks for; the merchant lists with it.
    function _acknowledge(string memory invoiceId, uint256 face, uint64 due) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(PAYER_KEY, market.acknowledgementDigest(invoiceId, merchant, payer, face, due));
        return abi.encodePacked(r, s, v);
    }

    function _listAs(string memory invoiceId, uint256 face, uint64 due, uint16 discountBps)
        internal
        returns (uint256 id)
    {
        bytes memory ack = _acknowledge(invoiceId, face, due);
        vm.prank(merchant);
        id = market.list(invoiceId, payer, face, due, discountBps, ack);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _domain(address verifying, string memory domainName) internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(domainName)),
                keccak256("1"),
                block.chainid,
                verifying
            )
        );
    }

    function _purchaseDigest(InvoiceReceivables.PurchaseOrder memory o, uint256 nonce) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(market.PURCHASE_TYPEHASH(), o.claimId, o.investor, o.units, o.maxPrice, nonce, o.deadline)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(address(market), "Pact Receivables"), structHash));
    }

    function _transferDigest(InvoiceReceivables.TransferOrder memory o, uint256 nonce) internal view returns (bytes32) {
        bytes32 structHash =
            keccak256(abi.encode(market.TRANSFER_TYPEHASH(), o.claimId, o.from, o.to, o.units, nonce, o.deadline));
        return keccak256(abi.encodePacked("\x19\x01", _domain(address(market), "Pact Receivables"), structHash));
    }

    function _permit(uint256 key, address owner, uint256 value, uint256 deadline)
        internal
        view
        returns (InvoiceReceivables.Permit memory)
    {
        bytes32 structHash = keccak256(
            abi.encode(token.PERMIT_TYPEHASH(), owner, address(market), value, token.nonces(owner), deadline)
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        return InvoiceReceivables.Permit(value, deadline, v, r, s);
    }

    function _noPermit() internal pure returns (InvoiceReceivables.Permit memory) {
        return InvoiceReceivables.Permit(0, 0, 0, bytes32(0), bytes32(0));
    }

    function _buy(address who, uint256 id, uint256 units) internal {
        vm.prank(who);
        market.buy(id, units);
    }

    function _status(uint256 id) internal view returns (InvoiceReceivables.Status status) {
        (,,,, status,,,,,,,,,) = market.claims(id);
    }

    function _reserve(uint256 id) internal view returns (uint256 reserve) {
        (,,,,,,,,, reserve,,,,) = market.claims(id);
    }

    function _received(uint256 id, address who) internal view returns (uint256 received) {
        (, received,) = market.holdings(id, who);
    }

    function _units(uint256 id, address who) internal view returns (uint256 units) {
        (units,,) = market.holdings(id, who);
    }

    /// The customer pays through the Router, signed like any sponsored payment.
    function _routerPay(uint256 id, bytes32 paymentId, uint256 amount, uint256 nonce) internal returns (bool ok) {
        bytes memory data = abi.encodeCall(market.pay, (id, paymentId, amount));
        Router.Intent memory i = Router.Intent(
            payer, merchant, address(market), keccak256(data), amount, nonce, uint64(block.timestamp + 1 hours), 900_000
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(PAYER_KEY, router.hashIntent(i));
        vm.prank(feeVault);
        (ok,) = router.execute(i, data, abi.encodePacked(r, s, v));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domain(address(market), "Pact Receivables"), structHash));
    }

    function _pay(uint256 id, bytes32 paymentId, uint256 amount) internal {
        vm.prank(payer);
        market.pay(id, paymentId, amount);
    }

    function _accounted() internal view returns (uint256 total) {
        for (uint256 id = 1; id <= market.claimCount(); id++) {
            total += _reserve(id);
        }
        total += market.totalClaimable();
    }

    // ---------------------------------------------------------------- registry

    function testRegistryApprovalExpiryAndRevocation() public {
        address dave = address(0xDA7E);
        assertFalse(registry.isApproved(dave));
        vm.prank(outsider);
        vm.expectRevert(InvestorRegistry.NotOfficer.selector);
        registry.approve(dave, uint64(block.timestamp + 1 days), "US");
        vm.prank(officer);
        vm.expectRevert(InvestorRegistry.InvalidExpiry.selector);
        registry.approve(dave, uint64(block.timestamp + 401 days), "US");
        vm.prank(officer);
        registry.approve(dave, uint64(block.timestamp + 1 days), "US");
        assertTrue(registry.isApproved(dave));
        vm.warp(block.timestamp + 1 days);
        assertFalse(registry.isApproved(dave), "expired");
        vm.prank(officer);
        registry.approve(dave, uint64(block.timestamp + 10 days), "US");
        vm.prank(officer);
        registry.revoke(dave);
        assertFalse(registry.isApproved(dave));
    }

    function testRegistryOwnershipIsTwoStep() public {
        registry.transferOwnership(outsider);
        assertEq(registry.owner(), address(this));
        vm.prank(alice);
        vm.expectRevert(InvestorRegistry.NotOwner.selector);
        registry.acceptOwnership();
        vm.prank(outsider);
        registry.acceptOwnership();
        assertEq(registry.owner(), outsider);
        vm.expectRevert(InvestorRegistry.NotOwner.selector);
        registry.setOfficer(alice, true);
        // The previous owner's officer role ends with its ownership; the new owner holds it.
        assertFalse(registry.officers(address(this)));
        assertTrue(registry.officers(outsider));
        vm.expectRevert(InvestorRegistry.NotOfficer.selector);
        registry.approve(alice, uint64(block.timestamp + 1 days), "GB");
    }

    // ---------------------------------------------------------------- review fixes

    /// Dust cannot end a listing or leave a remainder too small for a sponsored (1 USDT minimum) payment.
    function testDustPaymentsAreRefused() public {
        uint256 id = _list(300);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.pay(id, keccak256("dust"), 1);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Listed), "a dust payment cannot end the listing");
        _buy(alice, id, FACE);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.pay(id, keccak256("p1"), FACE - USDT / 2); // would leave 0.50 owed
        _pay(id, keccak256("p2"), FACE - USDT); // leaves exactly the minimum
        _pay(id, keccak256("p3"), USDT); // what is left may always be paid
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
    }

    /// One acknowledged debt backs one claim: not twice at once, and not again once sold or paid.
    function testAnAcknowledgementBacksOneClaim() public {
        bytes memory ack = _acknowledge("inv_1", FACE, maturity);
        uint256 id = _list(300);
        // The acknowledgement names the invoice: it cannot back another one.
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.InvalidAcknowledgement.selector);
        market.list("inv_1-copy", payer, FACE, maturity, 300, ack);
        // Cancelled with nothing sold: the acknowledgement is free again.
        vm.prank(merchant);
        market.cancel(id);
        uint256 again = _list(300);
        _buy(alice, again, FACE);
        _pay(again, keccak256("p1"), FACE);
        assertEq(uint8(_status(again)), uint8(InvoiceReceivables.Status.Repaid));
        // A paid invoice cannot be sold again: its pledge stays (and so does its acknowledgement).
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.AlreadyListed.selector);
        market.list("inv_1", payer, FACE, maturity, 300, ack);
        assertEq(
            market.acknowledgementClaim(market.acknowledgementDigest("inv_1", merchant, payer, FACE, maturity)), again
        );
        // A listing the customer paid into before any sale stays used too.
        uint256 other = _listAs("inv_3", FACE, maturity, 300);
        _pay(other, keccak256("p2"), 10 * USDT);
        assertEq(uint8(_status(other)), uint8(InvoiceReceivables.Status.Withdrawn));
        bytes memory ack3 = _acknowledge("inv_3", FACE, maturity);
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.AlreadyListed.selector);
        market.list("inv_3", payer, FACE, maturity, 300, ack3);
    }

    /// The contract checks the customer's acknowledgement: right invoice, amount, due date and merchant.
    function testListingRequiresTheCustomersAcknowledgement() public {
        bytes memory ack = _acknowledge("inv_1", FACE, maturity);
        vm.startPrank(merchant);
        vm.expectRevert(InvoiceReceivables.InvalidAcknowledgement.selector);
        market.list("inv_1", payer, FACE + 1, maturity, 300, ack); // a larger face value than acknowledged
        vm.expectRevert(InvoiceReceivables.InvalidAcknowledgement.selector);
        market.list("inv_1", payer, FACE, maturity + 1 days, 300, ack); // a later due date
        vm.expectRevert(InvoiceReceivables.InvalidAcknowledgement.selector);
        market.list("inv_1", outsider, FACE, maturity, 300, ack); // a debtor who did not sign
        vm.expectRevert(InvoiceReceivables.InvalidTerms.selector);
        market.list("inv_1", merchant, FACE, maturity, 300, ack); // a merchant cannot owe itself
        vm.stopPrank();
        // Another merchant cannot list this customer's acknowledgement of this merchant's invoice.
        vm.prank(outsider);
        vm.expectRevert(InvoiceReceivables.InvalidAcknowledgement.selector);
        market.list("inv_1", payer, FACE, maturity, 300, ack);
        vm.prank(merchant);
        uint256 id = market.list("inv_1", payer, FACE, maturity, 300, ack);
        (,,,,,,,,,,,, bytes32 ackHash, address debtor) = market.claims(id);
        assertEq(debtor, payer);
        assertEq(ackHash, market.acknowledgementDigest("inv_1", merchant, payer, FACE, maturity));
    }

    /// While a listing is open, only its debtor can pay into it: nobody else can cut a sale short.
    function testOnlyTheDebtorCanPayAnOpenListing() public {
        uint256 id = _list(300);
        _buy(alice, id, 100 * USDT);
        token.mint(outsider, 100 * USDT);
        vm.startPrank(outsider);
        token.approve(address(market), type(uint256).max);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.pay(id, keccak256("grief"), 10 * USDT);
        vm.stopPrank();
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Listed));
        _buy(bob, id, 100 * USDT); // the sale goes on
        // Once the listing has closed, anyone may pay toward the invoice: it only helps the holders.
        vm.prank(merchant);
        market.cancel(id);
        vm.prank(outsider);
        market.pay(id, keccak256("gift"), 10 * USDT);
    }

    // ---------------------------------------------------------------- signed orders (gasless)

    function testSignedPurchaseWithPermitNeedsNoGasFromTheInvestor() public {
        uint256 id = _list(300);
        vm.prank(alice);
        token.approve(address(market), 0); // no allowance: the permit provides it
        InvoiceReceivables.PurchaseOrder memory o =
            InvoiceReceivables.PurchaseOrder(id, alice, 600 * USDT, 582 * USDT, block.timestamp + 1 hours);
        bytes memory signature = _sign(ALICE_KEY, _purchaseDigest(o, 0));
        InvoiceReceivables.Permit memory permit = _permit(ALICE_KEY, alice, 582 * USDT, block.timestamp + 1 hours);
        uint256 before = token.balanceOf(alice);
        vm.prank(outsider); // a relayer: anyone may submit
        market.buyWithSig(o, signature, permit);
        assertEq(_units(id, alice), 600 * USDT);
        assertEq(before - token.balanceOf(alice), 582 * USDT);
        assertEq(market.nonces(alice), 1);
        // Replaying the same order fails: the nonce moved.
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.buyWithSig(o, signature, _noPermit());
    }

    function testSignedPurchaseRules() public {
        uint256 id = _list(300);
        InvoiceReceivables.PurchaseOrder memory o =
            InvoiceReceivables.PurchaseOrder(id, alice, 100 * USDT, 97 * USDT, block.timestamp + 1 hours);
        bytes memory good = _sign(ALICE_KEY, _purchaseDigest(o, 0));
        bytes memory wrong = _sign(BOB_KEY, _purchaseDigest(o, 0));
        InvoiceReceivables.Permit memory none = _noPermit();
        // Signed by someone else.
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.buyWithSig(o, wrong, none);
        // A limit below the listing's price.
        InvoiceReceivables.PurchaseOrder memory low =
            InvoiceReceivables.PurchaseOrder(id, alice, 100 * USDT, 96 * USDT, block.timestamp + 1 hours);
        bytes memory lowSig = _sign(ALICE_KEY, _purchaseDigest(low, 0));
        vm.expectRevert(InvoiceReceivables.PriceAboveLimit.selector);
        market.buyWithSig(low, lowSig, none);
        // Expired.
        InvoiceReceivables.PurchaseOrder memory late =
            InvoiceReceivables.PurchaseOrder(id, alice, 100 * USDT, 97 * USDT, block.timestamp - 1);
        bytes memory lateSig = _sign(ALICE_KEY, _purchaseDigest(late, 0));
        vm.expectRevert(InvoiceReceivables.SignatureExpired.selector);
        market.buyWithSig(late, lateSig, none);
        // The registry still applies to a signed purchase.
        vm.prank(officer);
        registry.revoke(alice);
        vm.expectRevert(abi.encodeWithSelector(InvoiceReceivables.NotApproved.selector, alice));
        market.buyWithSig(o, good, none);
        // A permit someone already submitted does not block the purchase.
        vm.prank(officer);
        registry.approve(alice, uint64(block.timestamp + 30 days), "GB");
        InvoiceReceivables.Permit memory permit = _permit(ALICE_KEY, alice, 97 * USDT, block.timestamp + 1 hours);
        token.permit(alice, address(market), permit.value, permit.deadline, permit.v, permit.r, permit.s);
        market.buyWithSig(o, good, permit);
        assertEq(_units(id, alice), 100 * USDT);
    }

    /// A customer or investor whose EOA is delegated with EIP-7702 (Pact's gasless approval) has code,
    /// but still signs with its own key: that signature counts.
    function testDelegatedAccountsStillSignWithTheirKeys() public {
        bytes memory delegated = abi.encodePacked(hex"ef0100", address(0x3CEc4a4Eff3c1ef0F8F8e1a4f20F98c2c2baBC3f));
        vm.etch(payer, delegated);
        vm.etch(alice, delegated);
        uint256 id = _list(300);
        InvoiceReceivables.PurchaseOrder memory o =
            InvoiceReceivables.PurchaseOrder(id, alice, 100 * USDT, 97 * USDT, block.timestamp + 1 hours);
        bytes memory signature = _sign(ALICE_KEY, _purchaseDigest(o, 0));
        market.buyWithSig(o, signature, _noPermit());
        assertEq(_units(id, alice), 100 * USDT);
    }

    /// A smart-account investor signs through ERC-1271.
    function testSmartAccountInvestorSignsThroughErc1271() public {
        SmartAccount account = new SmartAccount();
        token.mint(address(account), 1_000 * USDT);
        account.approve(token, address(market));
        vm.prank(officer);
        registry.approve(address(account), uint64(block.timestamp + 30 days), "GB");
        uint256 id = _list(300);
        InvoiceReceivables.PurchaseOrder memory o =
            InvoiceReceivables.PurchaseOrder(id, address(account), 100 * USDT, 97 * USDT, block.timestamp + 1 hours);
        bytes32 digest = _purchaseDigest(o, 0);
        account.allow(digest);
        market.buyWithSig(o, hex"01", _noPermit());
        assertEq(_units(id, address(account)), 100 * USDT);
    }

    function _decisionDigest(InvestorRegistry.Decision memory d, uint256 version, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                registry.DECISION_TYPEHASH(),
                d.officer,
                d.investor,
                d.approve,
                d.expiresAt,
                d.region,
                version,
                nonce,
                d.deadline
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", _domain(address(registry), "Pact Investor Registry"), structHash));
    }

    /// A signed approval still waiting to be submitted cannot undo a revocation made after it.
    function testAPendingApprovalCannotUndoARevocation() public {
        address dave = address(0xDA7E);
        InvestorRegistry.Decision memory d = InvestorRegistry.Decision(
            officer, dave, true, uint64(block.timestamp + 30 days), "FR", block.timestamp + 1 hours
        );
        bytes memory signature = _sign(OFFICER_KEY, _decisionDigest(d, 0, 0));
        vm.prank(address(this)); // the owner is an officer too
        registry.revoke(dave);
        vm.expectRevert(InvestorRegistry.InvalidSignature.selector);
        registry.decideWithSig(d, signature);
        assertFalse(registry.isApproved(dave));
    }

    /// An invoice that sold or was paid can never be listed again, even with a new acknowledgement.
    function testAPaidInvoiceCannotBeListedAgain() public {
        uint256 id = _list(300);
        _pay(id, keccak256("p1"), FACE); // paid in full while listed, before any sale
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Withdrawn));
        bytes memory fresh = _acknowledge("inv_1", FACE, maturity + 1 days);
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.AlreadyListed.selector);
        market.list("inv_1", payer, FACE, maturity + 1 days, 300, fresh);
        assertTrue(market.invoicePledged(merchant, INVOICE));
    }

    /// A later deployment honours what earlier ones pledged.
    function testPredecessorPledgesAreHonoured() public {
        bytes memory ack = _acknowledge("inv_1", FACE, maturity);
        _list(300);
        InvoiceReceivables.Config memory c = _config();
        c.predecessors = new address[](1);
        c.predecessors[0] = address(market);
        InvoiceReceivables next = new InvoiceReceivables(c);
        assertEq(next.predecessors()[0], address(market));
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.AcknowledgementUsed.selector);
        next.list("inv_1", payer, FACE, maturity, 300, ack);
        // A different invoice lists on the new deployment as usual.
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(PAYER_KEY, next.acknowledgementDigest("inv_9", merchant, payer, FACE, maturity));
        vm.prank(merchant);
        next.list("inv_9", payer, FACE, maturity, 300, abi.encodePacked(r, s, v));
    }

    /// A signer can void an order it signed that did not go through, directly or by signature.
    function testSignersCanCancelUnsentOrders() public {
        uint256 id = _list(300);
        InvoiceReceivables.PurchaseOrder memory o =
            InvoiceReceivables.PurchaseOrder(id, alice, 100 * USDT, 97 * USDT, block.timestamp + 1 hours);
        bytes memory signature = _sign(ALICE_KEY, _purchaseDigest(o, 0));
        // Signed cancellation, submitted by a relayer.
        bytes32 cancelHash =
            keccak256(abi.encode(market.CANCEL_TYPEHASH(), alice, uint256(0), block.timestamp + 1 hours));
        bytes memory cancel = _sign(
            ALICE_KEY, keccak256(abi.encodePacked("\x19\x01", _domain(address(market), "Pact Receivables"), cancelHash))
        );
        vm.prank(outsider);
        market.cancelNonceWithSig(alice, block.timestamp + 1 hours, cancel);
        assertEq(market.nonces(alice), 1);
        InvoiceReceivables.Permit memory none = _noPermit();
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.buyWithSig(o, signature, none);
        // Directly.
        vm.prank(bob);
        market.cancelNonce();
        assertEq(market.nonces(bob), 1);
        vm.prank(officer);
        registry.cancelNonce();
        assertEq(registry.nonces(officer), 1);
    }

    function testSignedTransfer() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        InvoiceReceivables.TransferOrder memory o =
            InvoiceReceivables.TransferOrder(id, alice, bob, 200 * USDT, block.timestamp + 1 hours);
        bytes memory good = _sign(ALICE_KEY, _transferDigest(o, 0));
        bytes memory wrong = _sign(BOB_KEY, _transferDigest(o, 0));
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.transferWithSig(o, wrong);
        vm.prank(outsider);
        market.transferWithSig(o, good);
        assertEq(_units(id, bob), 200 * USDT);
        assertEq(_units(id, alice), 400 * USDT);
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.transferWithSig(o, good);
    }

    function testOfficersSignDecisionsForARelayer() public {
        address dave = address(0xDA7E);
        InvestorRegistry.Decision memory d = InvestorRegistry.Decision(
            officer, dave, true, uint64(block.timestamp + 30 days), "FR", block.timestamp + 1 hours
        );
        bytes32 structHash = keccak256(
            abi.encode(
                registry.DECISION_TYPEHASH(),
                d.officer,
                d.investor,
                d.approve,
                d.expiresAt,
                d.region,
                uint256(0),
                uint256(0),
                d.deadline
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", _domain(address(registry), "Pact Investor Registry"), structHash));
        vm.prank(outsider);
        registry.decideWithSig(d, _sign(OFFICER_KEY, digest));
        assertTrue(registry.isApproved(dave));
        vm.expectRevert(InvestorRegistry.InvalidSignature.selector);
        registry.decideWithSig(d, _sign(OFFICER_KEY, digest)); // replay
        // A signer who is not an officer is refused even with a valid signature.
        InvestorRegistry.Decision memory fake =
            InvestorRegistry.Decision(alice, dave, false, 0, bytes2(0), block.timestamp + 1 hours);
        bytes32 fakeHash = keccak256(
            abi.encode(
                registry.DECISION_TYPEHASH(),
                fake.officer,
                fake.investor,
                fake.approve,
                fake.expiresAt,
                fake.region,
                registry.decisions(dave),
                uint256(0),
                fake.deadline
            )
        );
        vm.expectRevert(InvestorRegistry.NotOfficer.selector);
        registry.decideWithSig(
            fake,
            _sign(
                ALICE_KEY,
                keccak256(abi.encodePacked("\x19\x01", _domain(address(registry), "Pact Investor Registry"), fakeHash))
            )
        );
        assertTrue(registry.isApproved(dave));
    }

    // ---------------------------------------------------------------- listing

    function testConstructorRejectsUnsafeTerms() public {
        InvoiceReceivables.Config memory c = _config();
        c.lateFeeBps = 1_001;
        vm.expectRevert(InvoiceReceivables.InvalidConfig.selector);
        new InvoiceReceivables(c);
        c = _config();
        c.maxDiscountBps = 9_000;
        vm.expectRevert(InvoiceReceivables.InvalidConfig.selector);
        new InvoiceReceivables(c);
        c = _config();
        c.maxHolders = 0;
        vm.expectRevert(InvoiceReceivables.InvalidConfig.selector);
        new InvoiceReceivables(c);
    }

    function testListValidatesTermsAndOneOpenClaimPerInvoice() public {
        uint64 soon = uint64(block.timestamp + 1 days);
        bytes memory soonAck = _acknowledge("inv_1", FACE, soon);
        bytes memory ack = _acknowledge("inv_1", FACE, maturity);
        bytes memory small = _acknowledge("inv_1", USDT - 1, maturity);
        vm.startPrank(merchant);
        vm.expectRevert(InvoiceReceivables.InvalidTerms.selector);
        market.list("inv_1", payer, FACE, soon, 100, soonAck); // inside the record period
        vm.expectRevert(InvoiceReceivables.InvalidTerms.selector);
        market.list("inv_1", payer, FACE, maturity, 2_001, ack);
        vm.expectRevert(InvoiceReceivables.InvalidTerms.selector);
        market.list("", payer, FACE, maturity, 100, ack);
        vm.expectRevert(InvoiceReceivables.InvalidTerms.selector);
        market.list("inv_1", payer, USDT - 1, maturity, 100, small);
        uint256 id = market.list("inv_1", payer, FACE, maturity, 300, ack);
        vm.expectRevert(InvoiceReceivables.AlreadyListed.selector);
        market.list("inv_1", payer, FACE, maturity, 300, ack);
        market.cancel(id);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Cancelled));
        // A cancelled listing frees the invoice.
        uint256 again = market.list("inv_1", payer, FACE, maturity, 300, ack);
        assertEq(again, id + 1);
        assertEq(market.activeClaim(merchant, INVOICE), again);
        vm.stopPrank();
        vm.prank(outsider);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.cancel(again);
    }

    // ---------------------------------------------------------------- purchase

    function testPurchaseIsDeliveryVersusPayment() public {
        uint256 id = _list(300);
        uint256 merchantBefore = token.balanceOf(merchant);
        _buy(alice, id, 600 * USDT);
        // 600 face at 3% off: price 582, Pact fee 3, reserve 60, the merchant gets 519 now.
        assertEq(token.balanceOf(alice), 10_000 * USDT - 582 * USDT);
        assertEq(token.balanceOf(feeVault), 3 * USDT);
        assertEq(token.balanceOf(merchant) - merchantBefore, 519 * USDT);
        assertEq(token.balanceOf(address(market)), 60 * USDT);
        assertEq(_units(id, alice), 600 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Listed));
        _buy(bob, id, 400 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Funded), "fully sold closes the listing");
        assertEq(_reserve(id), 100 * USDT);
        assertEq(token.balanceOf(address(market)), _accounted());
        (uint256 price, uint256 fee, uint256 reserve, uint256 upfront) = market.quote(id, 400 * USDT);
        assertEq(price, 388 * USDT);
        assertEq(fee + reserve + upfront, price);
    }

    function testPurchaseRules() public {
        uint256 id = _list(300);
        vm.prank(outsider);
        vm.expectRevert(abi.encodeWithSelector(InvoiceReceivables.NotApproved.selector, outsider));
        market.buy(id, 100 * USDT);
        vm.prank(merchant);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.buy(id, 100 * USDT);
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.buy(id, USDT - 1); // below the minimum share
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.buy(id, FACE + 1);
        _buy(alice, id, FACE - USDT / 2);
        _buy(bob, id, USDT / 2); // all that is left may be below the minimum
        vm.prank(carol);
        vm.expectRevert(InvoiceReceivables.WrongStatus.selector);
        market.buy(id, USDT);
    }

    function testPurchaseClosesAtTheRecordDate() public {
        uint256 id = _list(300);
        vm.warp(maturity - 1 days);
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.TransfersClosed.selector);
        market.buy(id, 100 * USDT);
        // Nothing sold: the keeper withdraws the listing and the invoice is free again.
        market.closeListing(id);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Withdrawn));
        assertEq(market.activeClaim(merchant, INVOICE), 0);
    }

    function testHolderCap() public {
        uint256 id = _list(100);
        for (uint256 i; i < 8; i++) {
            address who = address(uint160(0x1000 + i));
            token.mint(who, 100 * USDT);
            vm.prank(who);
            token.approve(address(market), type(uint256).max);
            vm.prank(officer);
            registry.approve(who, uint64(block.timestamp + 30 days), "DE");
            _buy(who, id, 10 * USDT);
        }
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.TooManyHolders.selector);
        market.buy(id, 10 * USDT);
        // An existing holder may still buy more.
        _buy(address(0x1000), id, 10 * USDT);
    }

    /// The API budgets sponsored payment gas as 200k plus 75k per holder; the worst case must fit.
    function testPaymentGasWithTheMostHolders() public {
        uint256 id = _list(100);
        for (uint256 i; i < 8; i++) {
            address who = address(uint160(0x2000 + i));
            token.mint(who, 1_000 * USDT);
            vm.prank(who);
            token.approve(address(market), type(uint256).max);
            vm.prank(officer);
            registry.approve(who, uint64(block.timestamp + 30 days), "DE");
            _buy(who, id, i == 7 ? FACE - 7 * 100 * USDT : 100 * USDT);
        }
        vm.prank(payer);
        uint256 start = gasleft();
        market.pay(id, keccak256("final"), FACE); // pays eight holders and settles the reserve
        uint256 used = start - gasleft();
        emit log_named_uint("pay gas, eight holders", used);
        assertLt(used, 200_000 + 75_000 * 8, "payment gas budget");
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
    }

    // ---------------------------------------------------------------- repayment

    function testCustomerPaysThroughRouterAndHoldersArePaidDirectly() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        uint256 merchantBefore = token.balanceOf(merchant);
        uint256 aliceBefore = token.balanceOf(alice);
        uint256 bobBefore = token.balanceOf(bob);
        assertTrue(_routerPay(id, keccak256("pay-1"), FACE, 1));
        assertEq(token.balanceOf(alice) - aliceBefore, 600 * USDT);
        assertEq(token.balanceOf(bob) - bobBefore, 400 * USDT);
        // Paid on time: the whole reserve goes back to the merchant. A financed invoice's payment carries
        // no fee: Pact took its share when the units sold.
        assertEq(token.balanceOf(merchant) - merchantBefore, 100 * USDT);
        assertEq(token.balanceOf(feeVault), 5 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
        assertEq(token.balanceOf(address(market)), 0);
        assertEq(market.activeClaim(merchant, INVOICE), 0);
    }

    function testRouterQuoteNamesTheClaimMerchant() public {
        uint256 id = _list(300);
        _buy(alice, id, FACE);
        (address quoted, uint256 amount) =
            market.sponsorshipQuote(abi.encodeCall(market.pay, (id, keccak256("p"), 250 * USDT)));
        assertEq(quoted, merchant);
        assertEq(amount, 250 * USDT);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.sponsorshipQuote(abi.encodeCall(market.buy, (id, 1)));
        vm.warp(maturity + 7 days + 1);
        market.markDefault(id);
        (quoted, amount) = market.sponsorshipQuote(abi.encodeCall(market.buyBack, (id)));
        assertEq(quoted, merchant);
        assertEq(amount, market.owed(id));
    }

    function testPartialSaleSplitsEachPayment() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        vm.prank(merchant);
        market.cancel(id); // the merchant keeps the other 400
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Funded));
        uint256 merchantBefore = token.balanceOf(merchant);
        _pay(id, keccak256("p1"), 250 * USDT);
        assertEq(_received(id, alice), 150 * USDT);
        assertEq(token.balanceOf(merchant) - merchantBefore, 100 * USDT);
        _pay(id, keccak256("p2"), 750 * USDT);
        assertEq(_received(id, alice), 600 * USDT);
        // 400 for the part it kept, plus the 60 reserve released at settlement.
        assertEq(token.balanceOf(merchant) - merchantBefore, 460 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
    }

    function testPaymentWhileListedClosesTheListing() public {
        uint256 id = _list(300);
        _buy(alice, id, 500 * USDT);
        _pay(id, keccak256("p1"), 100 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Funded));
        assertEq(_received(id, alice), 50 * USDT);
        vm.prank(bob);
        vm.expectRevert(InvoiceReceivables.WrongStatus.selector);
        market.buy(id, 100 * USDT);
    }

    function testPaymentBeforeAnySaleWithdrawsTheListing() public {
        uint256 id = _list(300);
        uint256 merchantBefore = token.balanceOf(merchant);
        vm.expectEmit(true, true, true, true, address(market));
        emit InvoiceReceivables.Paid(
            id, keccak256("p1"), payer, 100 * USDT, 0, 100 * USDT - 500_000, 500_000, feeVault
        );
        _pay(id, keccak256("p1"), 100 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Withdrawn));
        // Never financed: paid like any invoice, less Pact's 0.5% invoice fee.
        assertEq(token.balanceOf(merchant) - merchantBefore, 100 * USDT - 500_000);
        assertEq(token.balanceOf(feeVault), 500_000);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.WrongStatus.selector);
        market.pay(id, keccak256("p2"), 100 * USDT);
    }

    function testPaymentIdsAreSingleUseAndAmountsBounded() public {
        uint256 id = _list(300);
        _buy(alice, id, FACE);
        _pay(id, keccak256("p1"), 100 * USDT);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.PaymentUsed.selector);
        market.pay(id, keccak256("p1"), 100 * USDT);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.pay(id, keccak256("p2"), FACE); // more than is left
        // The same id from another payer is a different payment: front-running it cannot block the payer.
        token.mint(outsider, 10 * USDT);
        vm.startPrank(outsider);
        token.approve(address(market), type(uint256).max);
        market.pay(id, keccak256("p3"), 10 * USDT);
        vm.stopPrank();
        _pay(id, keccak256("p3"), 10 * USDT);
    }

    function testLatePaymentPaysTheLateFeeFromTheReserve() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        vm.warp(maturity + 2 days);
        assertEq(market.owed(id), 1_010 * USDT, "the late fee is owed once past maturity");
        uint256 merchantBefore = token.balanceOf(merchant);
        _pay(id, keccak256("p1"), FACE);
        assertEq(_received(id, alice), 606 * USDT);
        assertEq(_received(id, bob), 404 * USDT);
        assertEq(token.balanceOf(merchant) - merchantBefore, 90 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
    }

    // ---------------------------------------------------------------- default

    function testDefaultPaysTheReserveThenTheMerchantBuysBack() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        vm.warp(maturity + 7 days);
        vm.expectRevert(InvoiceReceivables.TooEarly.selector);
        market.markDefault(id);
        vm.warp(maturity + 7 days + 1);
        market.markDefault(id);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Defaulted));
        assertEq(_received(id, alice), 60 * USDT);
        assertEq(_received(id, bob), 40 * USDT);
        assertEq(market.owed(id), 910 * USDT);
        // Frozen: no transfers.
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.TransfersClosed.selector);
        market.transfer(id, carol, 100 * USDT);
        vm.prank(outsider);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.buyBack(id);
        vm.prank(merchant);
        market.buyBack(id);
        assertEq(_received(id, alice), 606 * USDT);
        assertEq(_received(id, bob), 404 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.BoughtBack));
        assertEq(token.balanceOf(address(market)), 0);
        vm.prank(payer);
        vm.expectRevert(InvoiceReceivables.WrongStatus.selector);
        market.pay(id, keccak256("late"), 100 * USDT);
    }

    function testCustomerPaymentAfterDefaultGoesToHoldersFirst() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        _pay(id, keccak256("p1"), 200 * USDT); // part paid on time
        vm.warp(maturity + 8 days);
        market.markDefault(id);
        assertEq(market.owed(id), 710 * USDT); // 1,010 owed incl. late fee, less 200 paid and 100 reserve
        uint256 merchantBefore = token.balanceOf(merchant);
        _pay(id, keccak256("p2"), 800 * USDT);
        assertEq(_received(id, alice), 606 * USDT);
        assertEq(_received(id, bob), 404 * USDT);
        assertEq(token.balanceOf(merchant) - merchantBefore, 90 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid));
    }

    // ---------------------------------------------------------------- transfers

    function testTransfersMoveWhatWasReceivedProRata() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        _pay(id, keccak256("p1"), 500 * USDT); // alice 300, bob 200
        vm.prank(alice);
        market.transfer(id, carol, 300 * USDT);
        assertEq(_units(id, carol), 300 * USDT);
        assertEq(_received(id, carol), 150 * USDT);
        assertEq(_received(id, alice), 150 * USDT);
        vm.prank(bob);
        market.transfer(id, carol, 400 * USDT); // all of it: bob leaves the holder list
        (address[] memory accounts,,) = market.holdersOf(id);
        assertEq(accounts.length, 2);
        _pay(id, keccak256("p2"), 500 * USDT);
        assertEq(_received(id, alice), 300 * USDT);
        assertEq(_received(id, carol), 700 * USDT);
    }

    function testTransferRules() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InvoiceReceivables.NotApproved.selector, outsider));
        market.transfer(id, outsider, 100 * USDT);
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.InvalidRecipient.selector);
        market.transfer(id, merchant, 100 * USDT);
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.transfer(id, bob, USDT - 1);
        vm.prank(officer);
        registry.revoke(alice);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(InvoiceReceivables.NotApproved.selector, alice));
        market.transfer(id, bob, 100 * USDT);
        // A revoked holder keeps being paid.
        vm.prank(merchant);
        market.cancel(id);
        _pay(id, keccak256("p1"), FACE);
        assertEq(_received(id, alice), 600 * USDT);
        vm.prank(officer);
        registry.approve(alice, uint64(block.timestamp + 30 days), "GB");
        uint256 other = _listOther();
        _buy(alice, other, 100 * USDT);
        vm.warp(maturity - 1 days);
        vm.prank(alice);
        vm.expectRevert(InvoiceReceivables.TransfersClosed.selector);
        market.transfer(other, bob, 100 * USDT);
    }

    function _listOther() internal returns (uint256 id) {
        return _listAs("inv_2", FACE, maturity, 300);
    }

    // ---------------------------------------------------------------- signed merchant actions

    function _listOrder(string memory invoiceId) internal view returns (InvoiceReceivables.ListOrder memory) {
        return InvoiceReceivables.ListOrder(merchant, invoiceId, payer, FACE, maturity, 300, block.timestamp + 1 hours);
    }

    function _listDigest(InvoiceReceivables.ListOrder memory o, bytes memory ack, uint256 nonce)
        internal
        view
        returns (bytes32)
    {
        return _digest(
            keccak256(
                abi.encode(
                    market.LIST_TYPEHASH(),
                    o.merchant,
                    keccak256(bytes(o.invoiceId)),
                    o.debtor,
                    o.face,
                    o.maturity,
                    o.discountBps,
                    keccak256(ack),
                    nonce,
                    o.deadline
                )
            )
        );
    }

    function testAMerchantListsAndCancelsBySignatureWithoutGas() public {
        InvoiceReceivables.ListOrder memory o = _listOrder("inv_1");
        bytes memory ack = _acknowledge("inv_1", FACE, maturity);
        bytes memory signature = _sign(MERCHANT_KEY, _listDigest(o, ack, 0));
        // Anyone but the merchant signing is refused, and so is a changed term.
        o.discountBps = 400;
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.listWithSig(o, ack, signature);
        o.discountBps = 300;
        vm.prank(outsider);
        uint256 id = market.listWithSig(o, ack, signature);
        assertEq(market.activeClaim(merchant, INVOICE), id);
        assertEq(market.nonces(merchant), 1);
        assertEq(merchant.balance, 0);
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.listWithSig(o, ack, signature);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 cancelDigest =
            _digest(keccak256(abi.encode(market.CANCEL_LISTING_TYPEHASH(), merchant, id, uint256(1), deadline)));
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.cancelWithSig(merchant, id, deadline, _sign(ALICE_KEY, cancelDigest));
        // Another account's signature cannot cancel the merchant's listing in its own name either.
        bytes memory aliceSignature = _sign(
            ALICE_KEY, _digest(keccak256(abi.encode(market.CANCEL_LISTING_TYPEHASH(), alice, id, uint256(0), deadline)))
        );
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.cancelWithSig(alice, id, deadline, aliceSignature);
        market.cancelWithSig(merchant, id, deadline, _sign(MERCHANT_KEY, cancelDigest));
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Cancelled));
        vm.warp(deadline + 1);
        vm.expectRevert(InvoiceReceivables.SignatureExpired.selector);
        market.cancelWithSig(merchant, id, deadline, _sign(MERCHANT_KEY, cancelDigest));
    }

    function testListingNeedsAcceptedFeeTerms() public {
        uint256 newcomerKey = 0xD00D;
        address newcomer = vm.addr(newcomerKey);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(PAYER_KEY, market.acknowledgementDigest("inv_7", newcomer, payer, FACE, maturity));
        vm.prank(newcomer);
        vm.expectRevert(FeeSchedule.TermsNotAccepted.selector);
        market.list("inv_7", payer, FACE, maturity, 300, abi.encodePacked(r, s, v));
    }

    function testAHolderWithdrawsBySignature() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        token.setBlocked(bob, true);
        _pay(id, keccak256("p1"), FACE);
        token.setBlocked(bob, false);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 digest = _digest(keccak256(abi.encode(market.WITHDRAW_TYPEHASH(), bob, uint256(0), deadline)));
        vm.expectRevert(InvoiceReceivables.InvalidSignature.selector);
        market.withdrawWithSig(bob, deadline, _sign(ALICE_KEY, digest));
        uint256 before = token.balanceOf(bob);
        vm.prank(outsider);
        market.withdrawWithSig(bob, deadline, _sign(BOB_KEY, digest));
        assertEq(token.balanceOf(bob) - before, 400 * USDT);
        assertEq(market.totalClaimable(), 0);
    }

    function testASponsoredBuyBackChargesTheMerchantItsGas() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        vm.warp(maturity + 7 days + 1);
        market.markDefault(id);
        uint256 owed = market.owed(id);
        bytes memory data = abi.encodeCall(market.buyBack, (id));
        // A buy-back moves the merchant's money: only the merchant's own signature can send it.
        Router.Intent memory i = Router.Intent(
            alice, merchant, address(market), keccak256(data), owed, 1, uint64(block.timestamp + 1 hours), 900_000
        );
        vm.prank(feeVault);
        (bool ok,) = router.execute(i, data, _sign(ALICE_KEY, router.hashIntent(i)));
        assertFalse(ok);
        i.signer = merchant;
        uint256 merchantBefore = token.balanceOf(merchant);
        uint256 vaultBefore = token.balanceOf(feeVault);
        vm.prank(feeVault);
        (ok,) = router.execute(i, data, _sign(MERCHANT_KEY, router.hashIntent(i)));
        assertTrue(ok);
        uint256 gasFee = token.balanceOf(feeVault) - vaultBefore;
        assertGt(gasFee, 0);
        assertLe(gasFee, router.maxGasFee(i.maxGas, 1 gwei));
        assertEq(merchantBefore - token.balanceOf(merchant), owed + gasFee);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.BoughtBack));
    }

    // ---------------------------------------------------------------- delivery failures

    function testUndeliverablePaymentsAreCreditedNotLost() public {
        uint256 id = _list(300);
        _buy(alice, id, 600 * USDT);
        _buy(bob, id, 400 * USDT);
        token.setBlocked(bob, true);
        _pay(id, keccak256("p1"), FACE);
        assertEq(
            uint8(_status(id)), uint8(InvoiceReceivables.Status.Repaid), "one blocked holder cannot stall repayment"
        );
        assertEq(market.claimable(bob), 400 * USDT);
        assertEq(token.balanceOf(address(market)), _accounted());
        token.setBlocked(bob, false);
        uint256 before = token.balanceOf(bob);
        vm.prank(bob);
        market.withdraw();
        assertEq(token.balanceOf(bob) - before, 400 * USDT);
        assertEq(market.totalClaimable(), 0);
        vm.prank(bob);
        vm.expectRevert(InvoiceReceivables.InvalidAmount.selector);
        market.withdraw();
    }

    // ---------------------------------------------------------------- fuzz

    /// Any sale split, payment schedule and outcome keeps the books balanced and never pays a holder
    /// more than face value plus the late fee.
    function testFuzzBooksBalance(
        uint96 face,
        uint16 discountBps,
        uint8 splitA,
        uint8 splitB,
        uint8 payments,
        uint8 outcome
    ) public {
        uint256 f = bound(uint256(face), 10 * USDT, 5_000 * USDT);
        uint16 discount = uint16(bound(discountBps, 0, 2_000));
        uint256 id = _listAs("inv_1", f, maturity, discount);
        uint256 a = (f * bound(splitA, 1, 100)) / 200;
        uint256 b = ((f - a) * bound(splitB, 0, 100)) / 100;
        if (a < USDT) a = USDT;
        _buy(alice, id, a);
        if (b >= USDT && a + b <= f) _buy(bob, id, b);
        if (_status(id) == InvoiceReceivables.Status.Listed) {
            vm.prank(merchant);
            market.cancel(id);
        }
        uint256 n = bound(payments, 1, 5);
        uint256 collected;
        for (uint256 i; i < n; i++) {
            uint256 amount = (f - collected) / (n - i);
            if (outcome % 3 == 0 && i == n - 1) amount = f - collected;
            if (amount == 0) continue;
            if (outcome % 3 == 1) vm.warp(maturity + 1 days);
            _pay(id, keccak256(abi.encode("p", i)), amount);
            collected += amount;
            assertEq(token.balanceOf(address(market)), _accounted());
            if (_status(id) == InvoiceReceivables.Status.Repaid) break;
        }
        if (_status(id) == InvoiceReceivables.Status.Funded) {
            vm.warp(maturity + 8 days);
            market.markDefault(id);
            if (_status(id) == InvoiceReceivables.Status.Defaulted) {
                vm.prank(merchant);
                market.buyBack(id);
            }
        }
        assertEq(token.balanceOf(address(market)), _accounted());
        assertEq(market.owed(id), 0);
        (address[] memory accounts, uint256[] memory units, uint256[] memory received) = market.holdersOf(id);
        for (uint256 i; i < accounts.length; i++) {
            assertLe(received[i], units[i] + (units[i] * 100) / 10_000);
            assertGe(received[i], units[i]);
        }
    }

    // ---------------------------------------------------------------- EIP-3009 payments (v3)

    function _payAuthorization(uint256 key, uint256 id, bytes32 paymentId, uint256 amount)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        address from = vm.addr(key);
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                from,
                address(market),
                amount,
                uint256(0),
                block.timestamp + 1 hours,
                market.payAuthorizationNonce(id, paymentId, amount, from)
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function _payWithAuthorization(uint256 key, uint256 id, bytes32 paymentId, uint256 amount) internal {
        (uint8 v, bytes32 r, bytes32 s) = _payAuthorization(key, id, paymentId, amount);
        vm.prank(outsider);
        market.payWithAuthorization(id, paymentId, amount, vm.addr(key), 0, block.timestamp + 1 hours, v, r, s);
    }

    function testPayWithAuthorizationNeedsNoAllowance() public {
        uint256 id = _list(300);
        vm.prank(payer);
        token.approve(address(market), 0);
        uint256 merchantBefore = token.balanceOf(merchant);
        vm.expectEmit(true, true, true, true, address(market));
        emit InvoiceReceivables.Paid(id, keccak256("p1"), payer, 100 * USDT, 0, 100 * USDT - 500_000, 500_000, feeVault);
        _payWithAuthorization(PAYER_KEY, id, keccak256("p1"), 100 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Withdrawn));
        assertEq(token.balanceOf(merchant) - merchantBefore, 100 * USDT - 500_000);
        assertEq(token.balanceOf(feeVault), 500_000);
    }

    function testPayWithAuthorizationPaysTheHoldersLikePay() public {
        uint256 id = _list(300);
        _buy(alice, id, 500 * USDT);
        _payWithAuthorization(PAYER_KEY, id, keccak256("p1"), 100 * USDT);
        assertEq(uint8(_status(id)), uint8(InvoiceReceivables.Status.Funded));
        assertEq(_received(id, alice), 50 * USDT);
        // The same payment id is single-use whichever way it was paid.
        (uint8 v, bytes32 r, bytes32 s) = _payAuthorization(PAYER_KEY, id, keccak256("p1"), 100 * USDT);
        vm.expectRevert(InvoiceReceivables.PaymentUsed.selector);
        market.payWithAuthorization(id, keccak256("p1"), 100 * USDT, payer, 0, block.timestamp + 1 hours, v, r, s);
        vm.expectRevert(InvoiceReceivables.PaymentUsed.selector);
        _pay(id, keccak256("p1"), 100 * USDT);
    }

    function testThePayAuthorizationBindsAmountPaymentAndPayer() public {
        uint256 id = _list(300);
        _buy(alice, id, 500 * USDT);
        (uint8 v, bytes32 r, bytes32 s) = _payAuthorization(PAYER_KEY, id, keccak256("p1"), 100 * USDT);
        vm.expectRevert("invalid signature");
        market.payWithAuthorization(id, keccak256("p1"), 200 * USDT, payer, 0, block.timestamp + 1 hours, v, r, s);
        vm.expectRevert("invalid signature");
        market.payWithAuthorization(id, keccak256("p2"), 100 * USDT, payer, 0, block.timestamp + 1 hours, v, r, s);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.payWithAuthorization(id, keccak256("p1"), 100 * USDT, address(0), 0, block.timestamp + 1 hours, v, r, s);
        assertEq(_received(id, alice), 0);
    }

    function testOnlyTheDebtorPaysAnOpenListingByAuthorizationToo() public {
        uint256 id = _list(300);
        _buy(alice, id, 500 * USDT);
        (uint8 v, bytes32 r, bytes32 s) = _payAuthorization(BOB_KEY, id, keccak256("p1"), 100 * USDT);
        vm.expectRevert(InvoiceReceivables.NotAuthorized.selector);
        market.payWithAuthorization(id, keccak256("p1"), 100 * USDT, bob, 0, block.timestamp + 1 hours, v, r, s);
    }
}
