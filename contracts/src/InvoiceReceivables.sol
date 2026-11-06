// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Signatures} from "./Signatures.sol";
import {SponsoredContext} from "./SponsoredContext.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";

/// @notice What an earlier receivables deployment has pledged, so a debt is never sold on two of them.
interface IPledges {
    function acknowledgementClaim(bytes32 ackHash) external view returns (uint256);
    function invoicePledged(address merchant, bytes32 invoiceRef) external view returns (bool);
}

interface IInvestorRegistry {
    function isApproved(address investor) external view returns (bool);
}

/// @notice Invoice financing. A merchant lists an acknowledged invoice as a claim; approved investors
/// buy units of it (one unit is one micro-USDT of face value) and pay in the same transaction
/// (delivery versus payment). The merchant receives the price at once, less Pact's fee and a reserve
/// the contract holds. The customer pays the invoice to this contract, through the Router like any
/// sponsored payment, and the contract sends the holders their share straight away. Pact's fee on a
/// financed invoice is the share of each sale; a payment into a claim that never sold pays the
/// invoice rate from the merchant's accepted FeeSchedule terms instead. Every fee goes to the
/// FeeSchedule's recipient.
///
/// Rules, all fixed at deployment:
/// - Only investors approved in the registry can buy, send or receive units. Revoked holders keep
///   what they hold and keep being paid.
/// - Units stop moving `recordPeriod` before maturity (the record date), so who gets paid is fixed.
/// - Paid in full after maturity: the holders get `lateFeeBps` of their face value from the reserve.
/// - Unpaid `gracePeriod` after maturity: anyone may mark the claim defaulted. The units freeze, the
///   reserve goes to the holders and the merchant owes the rest as a buy-back. A later customer
///   payment goes to the holders first.
/// - A transfer that cannot be delivered is credited to the recipient, who can withdraw it.
/// - A listing carries the customer's EIP-712 acknowledgement of the debt ("Pact Invoices" domain),
///   checked here against the face value, due date and merchant; while it is open only that customer
///   (the debtor) can pay into it.
/// - Investors may buy, transfer and withdraw with a signature (and a USDT permit) that anyone
///   submits, and merchants may list, cancel and withdraw the same way, so a relayer pays the gas. A
///   buy-back goes through the Router, signed by the merchant, who pays its gas in USDT.
contract InvoiceReceivables is SponsoredContext, ReentrancyGuardTransient, EIP712 {
    using SafeERC20 for IERC20;

    error InvalidConfig();
    error NotAuthorized();
    error WrongStatus();
    error InvalidTerms();
    error InvalidAmount();
    error AlreadyListed();
    error NotApproved(address account);
    error TransfersClosed();
    error InvalidRecipient();
    error TooManyHolders();
    error PaymentUsed();
    error AcknowledgementUsed();
    error InvalidAcknowledgement();
    error InvalidSignature();
    error SignatureExpired();
    error PriceAboveLimit();
    error TooEarly();

    enum Status {
        None,
        Listed,
        Funded,
        Defaulted,
        Repaid,
        BoughtBack,
        Cancelled,
        Withdrawn
    }

    /// @notice Where a payment to a holder came from.
    enum Source {
        Customer,
        Reserve,
        BuyBack
    }

    struct Claim {
        address merchant;
        uint64 maturity;
        uint64 listedAt;
        uint16 discountBps;
        Status status;
        /// Set once a settlement or default happens after maturity: the late fee is owed.
        bool late;
        uint256 face;
        /// Units held by investors.
        uint256 sold;
        /// Customer payments received through this contract.
        uint256 collected;
        /// Reserve held now.
        uint256 reserve;
        /// The holders' share of customer payments so far.
        uint256 fromCustomer;
        bytes32 invoiceRef;
        bytes32 ackHash;
        /// The customer who signed the acknowledgement: the only payer while the listing is open.
        address debtor;
    }

    /// @notice A purchase an investor signs for a relayer to submit (EIP-712 `Purchase`).
    struct PurchaseOrder {
        uint256 claimId;
        address investor;
        uint256 units;
        /// The most the investor agrees to pay; the price itself follows the listing's terms.
        uint256 maxPrice;
        uint256 deadline;
    }

    /// @notice A transfer the sending investor signs for a relayer to submit (EIP-712 `Transfer`).
    struct TransferOrder {
        uint256 claimId;
        address from;
        address to;
        uint256 units;
        uint256 deadline;
    }

    /// @notice A listing the merchant signs for a relayer to submit (EIP-712 `List`).
    struct ListOrder {
        address merchant;
        string invoiceId;
        address debtor;
        uint256 face;
        uint64 maturity;
        uint16 discountBps;
        uint256 deadline;
    }

    /// @notice An optional EIP-2612 USDT permit for this contract, submitted with a signed purchase.
    struct Permit {
        uint256 value;
        uint256 deadline;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

    struct Holding {
        uint256 units;
        uint256 received;
        /// Position in the holder list, plus one; zero when not a holder.
        uint32 index;
    }

    struct Config {
        IERC20 usdt;
        address router;
        IInvestorRegistry registry;
        IFeeSchedule fees;
        uint16 feeBps;
        uint16 reserveBps;
        uint16 lateFeeBps;
        uint16 maxDiscountBps;
        uint32 gracePeriod;
        uint32 recordPeriod;
        uint256 minShare;
        uint8 maxHolders;
        /// Earlier deployments whose pledges this one honours (empty for the first).
        address[] predecessors;
    }

    uint256 private constant BPS = 10_000;
    uint8 private constant INVOICE = 1;
    uint256 private constant MAX_TERM = 400 days;
    /// @notice What the EIP-3009 nonce of `payWithAuthorization` commits to (with this contract and chain).
    bytes32 public constant PAY_AUTHORIZATION_TYPEHASH =
        keccak256("PayAuthorization(uint256 claimId,bytes32 paymentId,uint256 amount,address payer)");
    bytes32 public constant PURCHASE_TYPEHASH = keccak256(
        "Purchase(uint256 claimId,address investor,uint256 units,uint256 maxPrice,uint256 nonce,uint256 deadline)"
    );
    /// A signer gives up its current order nonce, so an order it signed but that did not go through can never run.
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(address signer,uint256 nonce,uint256 deadline)");
    bytes32 public constant TRANSFER_TYPEHASH =
        keccak256("Transfer(uint256 claimId,address from,address to,uint256 units,uint256 nonce,uint256 deadline)");
    bytes32 public constant LIST_TYPEHASH = keccak256(
        "List(address merchant,string invoiceId,address debtor,uint256 face,uint64 maturity,uint16 discountBps,bytes acknowledgement,uint256 nonce,uint256 deadline)"
    );
    bytes32 public constant CANCEL_LISTING_TYPEHASH =
        keccak256("CancelListing(address merchant,uint256 claimId,uint256 nonce,uint256 deadline)");
    bytes32 public constant WITHDRAW_TYPEHASH = keccak256("Withdraw(address account,uint256 nonce,uint256 deadline)");
    /// The customer's acknowledgement, as Pact's API asks for it: domain "Pact Invoices", version 1, this chain.
    bytes32 private constant ACK_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId)");
    bytes32 private constant ACK_TYPEHASH = keccak256(
        "InvoiceAcknowledgement(string invoiceId,address merchant,address payer,uint256 amount,uint256 dueAt,string statement)"
    );
    bytes32 private constant ACK_STATEMENT = keccak256("I received this invoice and owe the amount by the due date.");

    IERC20 public immutable usdt;
    IInvestorRegistry public immutable registry;
    IFeeSchedule public immutable fees;
    uint16 public immutable feeBps;
    uint16 public immutable reserveBps;
    uint16 public immutable lateFeeBps;
    uint16 public immutable maxDiscountBps;
    uint32 public immutable gracePeriod;
    uint32 public immutable recordPeriod;
    uint256 public immutable minShare;
    uint8 public immutable maxHolders;

    uint256 public claimCount;
    mapping(uint256 => Claim) public claims;
    mapping(uint256 => mapping(address => Holding)) public holdings;
    mapping(uint256 => address[]) private _holders;
    /// @notice The open claim for a merchant's invoice, or zero.
    mapping(address => mapping(bytes32 => uint256)) public activeClaim;
    /// @notice Customer payment ids already used, per payer.
    mapping(bytes32 => bool) public paymentUsed;
    /// @notice The claim an acknowledgement was sold under. An acknowledged debt can back one claim only;
    /// it is freed again only when that listing ends with nothing sold and nothing paid.
    mapping(bytes32 => uint256) public acknowledgementClaim;
    /// @notice Payments that could not be delivered, withdrawable by their recipient.
    mapping(address => uint256) public claimable;
    uint256 public totalClaimable;
    /// @notice Signed purchase and transfer orders used, per investor.
    mapping(address => uint256) public nonces;
    /// @notice A merchant's invoice once it backed a claim that sold or was paid: it can never be listed again.
    mapping(address => mapping(bytes32 => bool)) public invoicePledged;
    address[] private _predecessors;

    event Listed(
        uint256 indexed claimId,
        address indexed merchant,
        bytes32 indexed invoiceRef,
        uint256 face,
        uint64 maturity,
        uint16 discountBps,
        bytes32 ackHash,
        address debtor
    );
    event ListingClosed(uint256 indexed claimId, uint256 sold);
    event Cancelled(uint256 indexed claimId);
    event Withdrawn(uint256 indexed claimId);
    event Purchased(
        uint256 indexed claimId,
        address indexed investor,
        uint256 units,
        uint256 price,
        uint256 fee,
        uint256 reserve,
        uint256 upfront
    );
    event Transferred(
        uint256 indexed claimId, address indexed from, address indexed to, uint256 units, uint256 received
    );
    /// @notice `toMerchant` is what the merchant received, after `fee`, which went to `feeRecipient`
    /// (zero when there is no fee).
    event Paid(
        uint256 indexed claimId,
        bytes32 indexed paymentId,
        address indexed payer,
        uint256 amount,
        uint256 toHolders,
        uint256 toMerchant,
        uint256 fee,
        address feeRecipient
    );
    event HolderPaid(uint256 indexed claimId, address indexed holder, uint256 amount, Source source);
    event Settled(uint256 indexed claimId, uint256 fromReserve, uint256 reserveReleased);
    event Defaulted(uint256 indexed claimId, uint256 fromReserve, uint256 buyBackOwed);
    event BoughtBack(uint256 indexed claimId, uint256 amount);
    event Credited(address indexed account, uint256 amount);
    event Withdrawal(address indexed account, uint256 amount);
    event NonceCancelled(address indexed signer, uint256 nonce);

    constructor(Config memory c) SponsoredContext(c.router) EIP712("Pact Receivables", "1") {
        if (
            address(c.usdt) == address(0) || c.router == address(0) || address(c.registry) == address(0)
                || address(c.fees) == address(0) || address(c.usdt).code.length == 0
                || address(c.registry).code.length == 0 || address(c.fees).code.length == 0
        ) revert InvalidConfig();
        if (uint256(c.feeBps) + c.reserveBps + c.maxDiscountBps >= BPS || c.lateFeeBps > c.reserveBps) {
            revert InvalidConfig();
        }
        if (c.gracePeriod == 0 || c.recordPeriod == 0 || c.minShare == 0 || c.maxHolders == 0 || c.maxHolders > 16) {
            revert InvalidConfig();
        }
        usdt = c.usdt;
        registry = c.registry;
        fees = c.fees;
        feeBps = c.feeBps;
        reserveBps = c.reserveBps;
        lateFeeBps = c.lateFeeBps;
        maxDiscountBps = c.maxDiscountBps;
        gracePeriod = c.gracePeriod;
        recordPeriod = c.recordPeriod;
        minShare = c.minShare;
        maxHolders = c.maxHolders;
        for (uint256 i; i < c.predecessors.length; i++) {
            if (c.predecessors[i].code.length == 0) revert InvalidConfig();
            _predecessors.push(c.predecessors[i]);
        }
    }

    // ------------------------------------------------------------------ merchant

    /// @notice List an invoice. `face` is what the customer owes by `maturity`; `acknowledgement` is the
    /// customer's (the debtor's) EIP-712 signature that it received the invoice and owes exactly that,
    /// to this merchant, by then. `discountBps` is the investors' discount.
    function list(
        string calldata invoiceId,
        address debtor,
        uint256 face,
        uint64 maturity,
        uint16 discountBps,
        bytes calldata acknowledgement
    ) external nonReentrant returns (uint256) {
        return _list(msg.sender, invoiceId, debtor, face, maturity, discountBps, acknowledgement);
    }

    /// @notice A listing the merchant signed (EIP-712 `List`), submitted by anyone.
    function listWithSig(ListOrder calldata order, bytes calldata acknowledgement, bytes calldata signature)
        external
        nonReentrant
        returns (uint256)
    {
        if (block.timestamp > order.deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    LIST_TYPEHASH,
                    order.merchant,
                    keccak256(bytes(order.invoiceId)),
                    order.debtor,
                    order.face,
                    order.maturity,
                    order.discountBps,
                    keccak256(acknowledgement),
                    nonces[order.merchant],
                    order.deadline
                )
            )
        );
        if (!Signatures.isValid(order.merchant, digest, signature)) revert InvalidSignature();
        nonces[order.merchant]++;
        return _list(
            order.merchant,
            order.invoiceId,
            order.debtor,
            order.face,
            order.maturity,
            order.discountBps,
            acknowledgement
        );
    }

    function _list(
        address merchant,
        string calldata invoiceId,
        address debtor,
        uint256 face,
        uint64 maturity,
        uint16 discountBps,
        bytes calldata acknowledgement
    ) internal returns (uint256 claimId) {
        if (merchant == router || merchant == address(0)) revert NotAuthorized();
        if (bytes(invoiceId).length == 0 || debtor == address(0) || debtor == merchant) revert InvalidTerms();
        if (face < minShare || discountBps > maxDiscountBps) revert InvalidTerms();
        if (maturity <= block.timestamp + recordPeriod || maturity > block.timestamp + MAX_TERM) revert InvalidTerms();
        bytes32 invoiceRef = keccak256(bytes(invoiceId));
        bytes32 ackHash = acknowledgementDigest(invoiceId, merchant, debtor, face, maturity);
        if (!Signatures.isValid(debtor, ackHash, acknowledgement)) revert InvalidAcknowledgement();
        if (activeClaim[merchant][invoiceRef] != 0 || invoicePledged[merchant][invoiceRef]) revert AlreadyListed();
        for (uint256 i; i < _predecessors.length; i++) {
            IPledges p = IPledges(_predecessors[i]);
            if (p.acknowledgementClaim(ackHash) != 0 || p.invoicePledged(merchant, invoiceRef)) {
                revert AcknowledgementUsed();
            }
        }
        if (acknowledgementClaim[ackHash] != 0) revert AcknowledgementUsed();
        // A listing may end with the customer paying before any sale, at the invoice rate: the merchant
        // must have accepted terms that cover it. Reverts with the FeeSchedule's reason otherwise.
        fees.feeFor(merchant, INVOICE, face);
        claimId = ++claimCount;
        claims[claimId] = Claim({
            merchant: merchant,
            maturity: maturity,
            listedAt: uint64(block.timestamp),
            discountBps: discountBps,
            status: Status.Listed,
            late: false,
            face: face,
            sold: 0,
            collected: 0,
            reserve: 0,
            fromCustomer: 0,
            invoiceRef: invoiceRef,
            ackHash: ackHash,
            debtor: debtor
        });
        activeClaim[merchant][invoiceRef] = claimId;
        acknowledgementClaim[ackHash] = claimId;
        invoicePledged[merchant][invoiceRef] = true;
        emit Listed(claimId, merchant, invoiceRef, face, maturity, discountBps, ackHash, debtor);
    }

    /// @notice The EIP-712 digest a customer signs to acknowledge an invoice (domain "Pact Invoices").
    function acknowledgementDigest(
        string calldata invoiceId,
        address merchant,
        address debtor,
        uint256 amount,
        uint256 dueAt
    ) public view returns (bytes32) {
        bytes32 domain = keccak256(
            abi.encode(ACK_DOMAIN_TYPEHASH, keccak256("Pact Invoices"), keccak256("1"), block.chainid)
        );
        bytes32 structHash = keccak256(
            abi.encode(ACK_TYPEHASH, keccak256(bytes(invoiceId)), merchant, debtor, amount, dueAt, ACK_STATEMENT)
        );
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    /// @notice Take a listing down. With nothing sold it is cancelled; otherwise the listing closes
    /// and the merchant keeps the unsold part, paid to it directly when the customer pays.
    function cancel(uint256 claimId) external nonReentrant {
        _cancel(msg.sender, claimId);
    }

    /// @notice The same, signed by the merchant (EIP-712 `CancelListing`) for a relayer to submit.
    function cancelWithSig(address merchant, uint256 claimId, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
    {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(abi.encode(CANCEL_LISTING_TYPEHASH, merchant, claimId, nonces[merchant], deadline))
        );
        if (!Signatures.isValid(merchant, digest, signature)) revert InvalidSignature();
        nonces[merchant]++;
        _cancel(merchant, claimId);
    }

    function _cancel(address merchant, uint256 claimId) internal {
        Claim storage c = claims[claimId];
        if (merchant != c.merchant || merchant == address(0)) revert NotAuthorized();
        if (c.status != Status.Listed) revert WrongStatus();
        if (c.sold == 0) {
            c.status = Status.Cancelled;
            _release(c);
            _releaseAcknowledgement(c);
            emit Cancelled(claimId);
        } else {
            c.status = Status.Funded;
            emit ListingClosed(claimId, c.sold);
        }
    }

    /// @notice After a default, pay the holders everything still owed to them. The claim is closed.
    /// Through the Router the merchant signs, and the Router charges it the call's gas in USDT.
    function buyBack(uint256 claimId) external nonReentrant {
        Claim storage c = claims[claimId];
        _checkMerchant(c.merchant);
        address merchant = _actor();
        if (merchant != c.merchant || merchant == address(0)) revert NotAuthorized();
        if (c.status != Status.Defaulted) revert WrongStatus();
        uint256 due = _owed(claimId, c);
        usdt.safeTransferFrom(merchant, address(this), due);
        uint256 paid = _distribute(claimId, c, due, Source.BuyBack);
        if (paid != due) revert InvalidAmount();
        c.status = Status.BoughtBack;
        _release(c);
        uint256 left = c.reserve;
        c.reserve = 0;
        if (left > 0) _push(c.merchant, left);
        emit BoughtBack(claimId, paid);
    }

    // ------------------------------------------------------------------ investors

    /// @notice Buy `units` of a listed claim. Price, fee and reserve follow the listing's terms.
    function buy(uint256 claimId, uint256 units) external nonReentrant {
        _buy(claimId, msg.sender, units);
    }

    /// @notice A purchase the investor signed, submitted by anyone (Pact's relayer pays the gas). An
    /// optional USDT permit lets the contract take the price without an approval transaction.
    function buyWithSig(PurchaseOrder calldata order, bytes calldata signature, Permit calldata permit)
        external
        nonReentrant
    {
        if (block.timestamp > order.deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    PURCHASE_TYPEHASH,
                    order.claimId,
                    order.investor,
                    order.units,
                    order.maxPrice,
                    nonces[order.investor],
                    order.deadline
                )
            )
        );
        if (!Signatures.isValid(order.investor, digest, signature)) revert InvalidSignature();
        nonces[order.investor]++;
        if (permit.value > 0) {
            // Someone may already have submitted this permit; the allowance is what counts.
            try IERC20Permit(address(usdt))
                .permit(order.investor, address(this), permit.value, permit.deadline, permit.v, permit.r, permit.s) {}
                catch {}
        }
        if (_buy(order.claimId, order.investor, order.units) > order.maxPrice) revert PriceAboveLimit();
    }

    function _buy(uint256 claimId, address investor, uint256 units) internal returns (uint256) {
        Claim storage c = claims[claimId];
        if (c.status != Status.Listed) revert WrongStatus();
        if (block.timestamp >= _recordDate(c)) revert TransfersClosed();
        if (investor == c.merchant || investor == router) revert NotAuthorized();
        if (!registry.isApproved(investor)) revert NotApproved(investor);
        uint256 remaining = c.face - c.sold;
        if (units == 0 || units > remaining || (units < minShare && units != remaining)) revert InvalidAmount();
        (uint256 price, uint256 fee, uint256 reserve, uint256 upfront) = _quote(c, units);
        Holding storage h = holdings[claimId][investor];
        if (h.index == 0) _addHolder(claimId, investor);
        h.units += units;
        c.sold += units;
        c.reserve += reserve;
        usdt.safeTransferFrom(investor, address(this), price);
        if (fee > 0) _push(fees.recipient(), fee);
        if (upfront > 0) _push(c.merchant, upfront);
        emit Purchased(claimId, investor, units, price, fee, reserve, upfront);
        if (c.sold == c.face) {
            c.status = Status.Funded;
            emit ListingClosed(claimId, c.sold);
        }
        return price;
    }

    /// @notice Move `units` to another approved investor before the record date. What the units have
    /// already received travels with them, pro rata. Any price is agreed between the two investors.
    function transfer(uint256 claimId, address to, uint256 units) external nonReentrant {
        _transfer(claimId, msg.sender, to, units);
    }

    /// @notice A transfer the sending investor signed, submitted by anyone (Pact's relayer pays the gas).
    function transferWithSig(TransferOrder calldata order, bytes calldata signature) external nonReentrant {
        if (block.timestamp > order.deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    TRANSFER_TYPEHASH,
                    order.claimId,
                    order.from,
                    order.to,
                    order.units,
                    nonces[order.from],
                    order.deadline
                )
            )
        );
        if (!Signatures.isValid(order.from, digest, signature)) revert InvalidSignature();
        nonces[order.from]++;
        _transfer(order.claimId, order.from, order.to, order.units);
    }

    function _transfer(uint256 claimId, address from, address to, uint256 units) internal {
        Claim storage c = claims[claimId];
        if (c.status != Status.Listed && c.status != Status.Funded) revert TransfersClosed();
        if (block.timestamp >= _recordDate(c)) revert TransfersClosed();
        if (to == from || to == address(0) || to == c.merchant || to == router) revert InvalidRecipient();
        if (!registry.isApproved(from)) revert NotApproved(from);
        if (!registry.isApproved(to)) revert NotApproved(to);
        Holding storage h = holdings[claimId][from];
        if (units == 0 || units > h.units || (units < minShare && units != h.units)) revert InvalidAmount();
        uint256 moved = (h.received * units) / h.units;
        h.units -= units;
        h.received -= moved;
        if (h.units == 0) _removeHolder(claimId, from);
        Holding storage t = holdings[claimId][to];
        if (t.index == 0) _addHolder(claimId, to);
        t.units += units;
        t.received += moved;
        emit Transferred(claimId, from, to, units, moved);
    }

    /// @notice Give up the current order nonce: any order signed with it can no longer run.
    function cancelNonce() external nonReentrant {
        emit NonceCancelled(msg.sender, nonces[msg.sender]++);
    }

    /// @notice The same, signed (EIP-712 `Cancel`) for a relayer to submit, so it needs no gas.
    function cancelNonceWithSig(address signer, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, signer, nonces[signer], deadline)));
        if (!Signatures.isValid(signer, digest, signature)) revert InvalidSignature();
        emit NonceCancelled(signer, nonces[signer]++);
    }

    /// @notice Earlier deployments whose pledges this one honours.
    function predecessors() external view returns (address[] memory) {
        return _predecessors;
    }

    /// @notice Withdraw payments that could not be delivered.
    function withdraw() external nonReentrant {
        _withdraw(msg.sender);
    }

    /// @notice The same, signed (EIP-712 `Withdraw`) for a relayer to submit, so it needs no gas.
    function withdrawWithSig(address account, uint256 deadline, bytes calldata signature) external nonReentrant {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(WITHDRAW_TYPEHASH, account, nonces[account], deadline)));
        if (!Signatures.isValid(account, digest, signature)) revert InvalidSignature();
        nonces[account]++;
        _withdraw(account);
    }

    function _withdraw(address account) internal {
        uint256 amount = claimable[account];
        if (amount == 0 || account == address(0)) revert InvalidAmount();
        claimable[account] = 0;
        totalClaimable -= amount;
        usdt.safeTransfer(account, amount);
        emit Withdrawal(account, amount);
    }

    // ------------------------------------------------------------------ customer

    /// @notice Pay `amount` of the invoice behind a claim. Through the Router, the payer is the signer
    /// and Pact's relayer pays the gas. `paymentId` is single-use per payer. A payment is at
    /// least the minimum share and leaves either nothing or at least the minimum share owed, unless it
    /// pays exactly what is left: so dust cannot end a listing cheaply or leave a remainder too small
    /// for a sponsored payment.
    function pay(uint256 claimId, bytes32 paymentId, uint256 amount) external nonReentrant {
        Claim storage c = claims[claimId];
        _checkMerchant(c.merchant);
        _pay(claimId, c, paymentId, amount, _actor(), "");
    }

    /// @notice `pay` with the payer's EIP-3009 `ReceiveWithAuthorization` signature instead of an
    /// allowance: `from` the payer, `to` this contract, `value` the amount, `nonce` =
    /// `payAuthorizationNonce(claimId, paymentId, amount, payer)`. Anyone may submit it.
    function payWithAuthorization(
        uint256 claimId,
        bytes32 paymentId,
        uint256 amount,
        address payer,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        if (payer == address(0)) revert NotAuthorized();
        _pay(claimId, claims[claimId], paymentId, amount, payer, abi.encode(validAfter, validBefore, v, r, s));
    }

    /// @notice The EIP-3009 nonce a payer signs for `payWithAuthorization`: it commits to the claim,
    /// the payment id, the amount and the payer, on this contract and chain.
    function payAuthorizationNonce(uint256 claimId, bytes32 paymentId, uint256 amount, address payer)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(PAY_AUTHORIZATION_TYPEHASH, claimId, paymentId, amount, payer, address(this), block.chainid)
        );
    }

    function _pay(
        uint256 claimId,
        Claim storage c,
        bytes32 paymentId,
        uint256 amount,
        address payer,
        bytes memory authorization
    ) internal {
        if (c.status != Status.Listed && c.status != Status.Funded && c.status != Status.Defaulted) {
            revert WrongStatus();
        }
        bytes32 key = keccak256(abi.encode(payer, paymentId));
        if (paymentId == bytes32(0) || paymentUsed[key]) revert PaymentUsed();
        // An open listing ends only when its own debtor pays: nobody else can cut a sale short.
        if (c.status == Status.Listed && payer != c.debtor) revert NotAuthorized();
        uint256 left = c.face - c.collected;
        if (amount == 0 || amount > left) revert InvalidAmount();
        if (amount != left && (amount < minShare || left - amount < minShare)) revert InvalidAmount();
        paymentUsed[key] = true;
        c.collected += amount;
        if (authorization.length == 0) {
            usdt.safeTransferFrom(payer, address(this), amount);
        } else {
            (uint256 validAfter, uint256 validBefore, uint8 v, bytes32 r, bytes32 s) =
                abi.decode(authorization, (uint256, uint256, uint8, bytes32, bytes32));
            IERC3009(address(usdt)).receiveWithAuthorization(
                payer,
                address(this),
                amount,
                validAfter,
                validBefore,
                payAuthorizationNonce(claimId, paymentId, amount, payer),
                v,
                r,
                s
            );
        }
        if (c.status == Status.Listed) {
            if (c.sold == 0) {
                // Paid before any investor bought: the listing ends and the merchant is paid as for any
                // invoice, less Pact's invoice fee.
                c.status = Status.Withdrawn;
                _release(c);
                emit Withdrawn(claimId);
                (uint256 fee, address recipient) = fees.quote(c.merchant, INVOICE, amount);
                _push(c.merchant, amount - fee);
                if (fee > 0) _push(recipient, fee);
                emit Paid(claimId, paymentId, payer, amount, 0, amount - fee, fee, fee > 0 ? recipient : address(0));
                return;
            }
            c.status = Status.Funded;
            emit ListingClosed(claimId, c.sold);
        }
        uint256 share;
        if (c.status == Status.Funded) {
            // The holders' part of everything collected so far, in proportion to the face they hold.
            share = (c.collected * c.sold) / c.face - c.fromCustomer;
        } else {
            share = amount; // Defaulted: the holders are paid first.
        }
        uint256 toHolders = _distribute(claimId, c, share, Source.Customer);
        c.fromCustomer += toHolders;
        uint256 toMerchant = amount - toHolders;
        if (toMerchant > 0) _push(c.merchant, toMerchant);
        emit Paid(claimId, paymentId, payer, amount, toHolders, toMerchant, 0, address(0));
        if (c.status == Status.Funded && c.collected == c.face) _settle(claimId, c);
        else if (c.status == Status.Defaulted && _owed(claimId, c) == 0) _close(claimId, c);
    }

    /// @notice The Router's check of what a sponsored call commits: the claim's merchant and the amount.
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount) {
        if (data.length < 4) revert InvalidAmount();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.pay.selector) {
            (uint256 claimId,, uint256 value) = abi.decode(data[4:], (uint256, bytes32, uint256));
            return (claims[claimId].merchant, value);
        }
        if (selector == this.buyBack.selector) {
            uint256 claimId = abi.decode(data[4:], (uint256));
            Claim storage c = claims[claimId];
            return (c.merchant, _owed(claimId, c));
        }
        revert InvalidAmount();
    }

    // ------------------------------------------------------------------ keeper

    /// @notice At the record date, end a listing: closed if anything sold, withdrawn otherwise.
    function closeListing(uint256 claimId) external nonReentrant {
        Claim storage c = claims[claimId];
        if (c.status != Status.Listed) revert WrongStatus();
        if (block.timestamp < _recordDate(c)) revert TooEarly();
        _closeListing(claimId, c);
    }

    /// @notice After the grace period with money still owed: freeze the claim, pay the reserve to the
    /// holders and leave the rest owed by the merchant as a buy-back.
    function markDefault(uint256 claimId) external nonReentrant {
        Claim storage c = claims[claimId];
        if (c.status == Status.Listed && block.timestamp >= _recordDate(c)) _closeListing(claimId, c);
        if (c.status != Status.Funded) revert WrongStatus();
        if (block.timestamp <= uint256(c.maturity) + gracePeriod) revert TooEarly();
        c.late = true;
        uint256 due = _owed(claimId, c);
        uint256 fromReserve = _distribute(claimId, c, due < c.reserve ? due : c.reserve, Source.Reserve);
        c.reserve -= fromReserve;
        c.status = Status.Defaulted;
        uint256 left = _owed(claimId, c);
        emit Defaulted(claimId, fromReserve, left);
        if (left == 0) _close(claimId, c);
    }

    // ------------------------------------------------------------------ views

    function recordDate(uint256 claimId) external view returns (uint256) {
        return _recordDate(claims[claimId]);
    }

    /// @notice Everything still owed to the holders, including the late fee once it applies.
    function owed(uint256 claimId) external view returns (uint256) {
        return _owed(claimId, claims[claimId]);
    }

    function holdersOf(uint256 claimId)
        external
        view
        returns (address[] memory accounts, uint256[] memory units, uint256[] memory received)
    {
        accounts = _holders[claimId];
        units = new uint256[](accounts.length);
        received = new uint256[](accounts.length);
        for (uint256 i; i < accounts.length; i++) {
            Holding storage h = holdings[claimId][accounts[i]];
            units[i] = h.units;
            received[i] = h.received;
        }
    }

    /// @notice What `units` of a listed claim cost, and how the price splits.
    function quote(uint256 claimId, uint256 units)
        external
        view
        returns (uint256 price, uint256 fee, uint256 reserve, uint256 upfront)
    {
        return _quote(claims[claimId], units);
    }

    // ------------------------------------------------------------------ internals

    function _recordDate(Claim storage c) internal view returns (uint256) {
        return uint256(c.maturity) - recordPeriod;
    }

    function _quote(Claim storage c, uint256 units)
        internal
        view
        returns (uint256 price, uint256 fee, uint256 reserve, uint256 upfront)
    {
        price = units - (units * c.discountBps) / BPS;
        fee = (units * feeBps) / BPS;
        reserve = (units * reserveBps) / BPS;
        upfront = price - fee - reserve;
    }

    function _late(Claim storage c) internal view returns (bool) {
        return c.late || (c.status == Status.Funded && block.timestamp > c.maturity);
    }

    function _entitlement(uint256 units, bool late) internal view returns (uint256) {
        return late ? units + (units * lateFeeBps) / BPS : units;
    }

    function _owed(uint256 claimId, Claim storage c) internal view returns (uint256 total) {
        bool late = _late(c);
        address[] storage accounts = _holders[claimId];
        for (uint256 i; i < accounts.length; i++) {
            Holding storage h = holdings[claimId][accounts[i]];
            uint256 due = _entitlement(h.units, late);
            if (due > h.received) total += due - h.received;
        }
    }

    /// @dev Splits `amount` across the holders in proportion to their units, never more than each is
    /// still owed, and pays them from this contract's balance. Returns what was paid.
    function _distribute(uint256 claimId, Claim storage c, uint256 amount, Source source)
        internal
        returns (uint256 given)
    {
        address[] storage accounts = _holders[claimId];
        uint256 n = accounts.length;
        if (amount == 0 || n == 0) return 0;
        bool late = _late(c);
        uint256[] memory dues = new uint256[](n);
        uint256 totalDue;
        for (uint256 i; i < n; i++) {
            Holding storage h = holdings[claimId][accounts[i]];
            uint256 due = _entitlement(h.units, late);
            dues[i] = due > h.received ? due - h.received : 0;
            totalDue += dues[i];
        }
        if (amount > totalDue) amount = totalDue;
        if (amount == 0) return 0;
        uint256[] memory parts = new uint256[](n);
        for (uint256 i; i < n; i++) {
            uint256 part = (amount * holdings[claimId][accounts[i]].units) / c.sold;
            parts[i] = part > dues[i] ? dues[i] : part;
            given += parts[i];
        }
        for (uint256 i; i < n && given < amount; i++) {
            uint256 room = dues[i] - parts[i];
            uint256 extra = room < amount - given ? room : amount - given;
            parts[i] += extra;
            given += extra;
        }
        for (uint256 i; i < n; i++) {
            if (parts[i] == 0) continue;
            address holder = accounts[i];
            holdings[claimId][holder].received += parts[i];
            _push(holder, parts[i]);
            emit HolderPaid(claimId, holder, parts[i], source);
        }
    }

    /// @dev Paid in full by the customer: the late fee (if any) from the reserve, the rest of the
    /// reserve back to the merchant.
    function _settle(uint256 claimId, Claim storage c) internal {
        if (block.timestamp > c.maturity) c.late = true;
        uint256 due = _owed(claimId, c);
        uint256 fromReserve = _distribute(claimId, c, due < c.reserve ? due : c.reserve, Source.Reserve);
        c.reserve -= fromReserve;
        uint256 released = c.reserve;
        c.reserve = 0;
        c.status = Status.Repaid;
        _release(c);
        if (released > 0) _push(c.merchant, released);
        emit Settled(claimId, fromReserve, released);
    }

    /// @dev The holders are owed nothing more: close the claim and return any reserve left.
    function _close(uint256 claimId, Claim storage c) internal {
        uint256 released = c.reserve;
        c.reserve = 0;
        c.status = Status.Repaid;
        _release(c);
        if (released > 0) _push(c.merchant, released);
        emit Settled(claimId, 0, released);
    }

    function _closeListing(uint256 claimId, Claim storage c) internal {
        if (c.sold == 0) {
            c.status = Status.Withdrawn;
            _release(c);
            // Nothing was sold or paid (a payment ends a listing itself): the debt was never pledged.
            if (c.collected == 0) _releaseAcknowledgement(c);
            emit Withdrawn(claimId);
        } else {
            c.status = Status.Funded;
            emit ListingClosed(claimId, c.sold);
        }
    }

    function _release(Claim storage c) internal {
        delete activeClaim[c.merchant][c.invoiceRef];
    }

    /// @dev Nothing was sold or paid: the debt was never pledged, so the invoice and its acknowledgement are free.
    function _releaseAcknowledgement(Claim storage c) internal {
        delete acknowledgementClaim[c.ackHash];
        delete invoicePledged[c.merchant][c.invoiceRef];
    }

    function _addHolder(uint256 claimId, address account) internal {
        address[] storage accounts = _holders[claimId];
        if (accounts.length >= maxHolders) revert TooManyHolders();
        accounts.push(account);
        holdings[claimId][account].index = uint32(accounts.length);
    }

    function _removeHolder(uint256 claimId, address account) internal {
        address[] storage accounts = _holders[claimId];
        uint256 index = holdings[claimId][account].index - 1;
        address last = accounts[accounts.length - 1];
        accounts[index] = last;
        holdings[claimId][last].index = uint32(index + 1);
        accounts.pop();
        delete holdings[claimId][account];
    }

    /// @dev Pays `to` from this contract, or credits it for `withdraw` if the token refuses.
    function _push(address to, uint256 amount) internal {
        (bool ok, bytes memory ret) = address(usdt).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || (ret.length >= 32 && abi.decode(ret, (bool))))) return;
        claimable[to] += amount;
        totalClaimable += amount;
        emit Credited(to, amount);
    }
}
