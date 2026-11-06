// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SponsoredContext} from "./SponsoredContext.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";
import {IERC3009} from "./interfaces/IERC3009.sol";
import {ISignatureTransfer} from "./interfaces/ISignatureTransfer.sol";

/// @notice USDT checkout with authorization, capture, release and bounded merchant refunds.
/// @dev Pact's fee comes out of the money that reaches the merchant: on `charge`, `chargeInvoice`,
/// `capture` and the one-signature collectors the merchant receives the amount less the fee its
/// accepted terms set, and the fee goes to the FeeSchedule's recipient. Authorizing, voiding and
/// reclaiming carry no fee. A refund returns the full amount from the merchant's wallet; the Router
/// charges the merchant that call's gas.
///
/// v3: a payment is two storage slots (a charge writes nothing else); captured and refunded amounts
/// live in a third slot written only by `capture` and `refund`. Two collectors take a payment with a
/// single payer signature and no prior allowance, submitted by anyone (Pact's relayer pays the gas):
/// `chargeWithAuthorization` (EIP-3009 `receiveWithAuthorization`, whose nonce commits to the
/// payment's terms) and `chargeWithPermit2` (a Permit2 transfer whose witness is the terms).
contract PaymentEscrow is SponsoredContext, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error InvalidPayment();
    error InvalidAmount();
    error NotAuthorized();
    error Expired();
    error TooEarly();
    error RefundWindowClosed();
    error InvalidTerms();
    error Overflow();

    /// @dev Slot 0: payer, amount, refund window. Slot 1: merchant, refund deadline, expiry, product, flags.
    struct Payment {
        address payer;
        uint64 authorized;
        uint32 refundWindow;
        address merchant;
        uint40 refundDeadline;
        uint40 expiry;
        uint8 product;
        uint8 flags;
    }

    /// @dev Written only when an authorization is captured or a payment refunded. A charge's captured
    /// amount is its whole amount (the CHARGED flag), so a charge never writes this slot.
    struct Settlement {
        uint64 captured;
        uint64 refunded;
    }

    struct PaymentView {
        address payer;
        address merchant;
        uint256 authorized;
        uint256 captured;
        uint256 refunded;
        uint64 expiry;
        uint64 refundDeadline;
        uint32 refundWindow;
        bool closed;
        uint8 product;
    }

    /// @notice What a payer signs for a one-signature payment: the payment id, both parties, the amount,
    /// the refund window and the FeeSchedule product (0 checkout, 1 invoice).
    struct Terms {
        bytes32 id;
        address payer;
        address merchant;
        uint256 amount;
        uint32 refundWindow;
        uint8 product;
    }

    uint8 private constant CHECKOUT = 0;
    uint8 private constant INVOICE = 1;
    uint8 private constant CLOSED = 1;
    uint8 private constant CHARGED = 2;

    string public constant TERMS_TYPE =
        "Terms(bytes32 id,address payer,address merchant,uint256 amount,uint32 refundWindow,uint8 product)";
    bytes32 public constant TERMS_TYPEHASH = keccak256(
        "Terms(bytes32 id,address payer,address merchant,uint256 amount,uint32 refundWindow,uint8 product)"
    );
    /// @notice The witness type string for Permit2's `permitWitnessTransferFrom`: the payer signs
    /// `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Terms witness)`
    /// with `spender` this escrow.
    string public constant PERMIT2_WITNESS_TYPE =
        "Terms witness)Terms(bytes32 id,address payer,address merchant,uint256 amount,uint32 refundWindow,uint8 product)TokenPermissions(address token,uint256 amount)";

    IERC20 public immutable usdt;
    IFeeSchedule public immutable fees;
    ISignatureTransfer public immutable permit2;
    mapping(bytes32 => Payment) private _payments;
    mapping(bytes32 => Settlement) private _settlements;

    event Authorized(
        bytes32 indexed id,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint64 expiry,
        uint32 refundWindow
    );
    event Captured(
        bytes32 indexed id,
        uint256 amount,
        uint256 fee,
        uint64 refundDeadline,
        uint32 refundWindow,
        address feeRecipient
    );
    /// @notice `product` is the FeeSchedule product the fee followed: 0 checkout, 1 invoice.
    event Charged(
        bytes32 indexed id,
        address indexed payer,
        address indexed merchant,
        uint256 amount,
        uint256 fee,
        uint8 product,
        uint64 refundDeadline,
        uint32 refundWindow,
        address feeRecipient
    );
    event Voided(bytes32 indexed id, uint256 amount);
    event Reclaimed(bytes32 indexed id, uint256 amount);
    event Refunded(bytes32 indexed id, uint256 amount, bytes32 reason);

    constructor(IERC20 usdt_, address router_, IFeeSchedule fees_, ISignatureTransfer permit2_)
        SponsoredContext(router_)
    {
        if (address(usdt_) == address(0) || address(fees_) == address(0) || address(permit2_) == address(0)) {
            revert InvalidPayment();
        }
        usdt = usdt_;
        fees = fees_;
        permit2 = permit2_;
    }

    // ------------------------------------------------------------------ views

    function payment(bytes32 id) external view returns (PaymentView memory v) {
        Payment storage p = _payments[id];
        v.payer = p.payer;
        v.merchant = p.merchant;
        v.authorized = p.authorized;
        v.captured = _captured(id, p);
        v.refunded = _settlements[id].refunded;
        v.expiry = p.expiry;
        v.refundDeadline = p.refundDeadline;
        v.refundWindow = p.refundWindow;
        v.closed = p.flags & CLOSED != 0;
        v.product = p.product;
    }

    /// @notice The refund deadline (0 until something is captured) and the refund window of a payment.
    function paymentTerms(bytes32 id) external view returns (uint64 refundDeadline, uint32 refundWindow) {
        Payment storage p = _payments[id];
        return (p.refundDeadline, p.refundWindow);
    }

    /// @notice The EIP-712 struct hash of `t`: the Permit2 witness.
    function hashTerms(Terms calldata t) public pure returns (bytes32) {
        return keccak256(abi.encode(TERMS_TYPEHASH, t.id, t.payer, t.merchant, t.amount, t.refundWindow, t.product));
    }

    /// @notice The EIP-3009 nonce a payer signs for `t`. It commits to every term, this escrow and the
    /// chain, so an authorization pays exactly one payment, here, as signed.
    function authorizationNonce(Terms calldata t) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                TERMS_TYPEHASH,
                t.id,
                t.payer,
                t.merchant,
                t.amount,
                t.refundWindow,
                t.product,
                address(this),
                block.chainid
            )
        );
    }

    /// @notice Return the merchant and economic amount committed by sponsored calldata.
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount) {
        if (data.length < 4) revert InvalidPayment();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.authorize.selector) {
            (, merchant, amount,,) = abi.decode(data[4:], (bytes32, address, uint256, uint64, uint64));
        } else if (selector == this.charge.selector || selector == this.chargeInvoice.selector) {
            (, merchant, amount,) = abi.decode(data[4:], (bytes32, address, uint256, uint64));
        } else if (selector == this.capture.selector) {
            (bytes32 id, uint256 value) = abi.decode(data[4:], (bytes32, uint256));
            merchant = _payments[id].merchant;
            amount = value;
        } else if (selector == this.refund.selector) {
            (bytes32 id, uint256 value,) = abi.decode(data[4:], (bytes32, uint256, bytes32));
            merchant = _payments[id].merchant;
            amount = value;
        } else if (selector == this.void.selector || selector == this.reclaim.selector) {
            bytes32 id = abi.decode(data[4:], (bytes32));
            Payment storage p = _payments[id];
            merchant = p.merchant;
            amount = p.authorized - _captured(id, p);
        } else {
            revert InvalidPayment();
        }
    }

    // ------------------------------------------------------------------ Router-mediated

    /// @notice Lock payer USDT until capture, void, or expiry.
    function authorize(bytes32 id, address merchant, uint256 amount, uint64 expiry, uint64 refundWindow)
        external
        nonReentrant
    {
        _checkMerchant(merchant);
        if (_payments[id].payer != address(0) || merchant == address(0)) revert InvalidPayment();
        if (amount == 0 || refundWindow == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert Expired();
        address payer = _actor();
        _payments[id] = Payment(payer, _u64(amount), _u32(refundWindow), merchant, 0, _u40(expiry), CHECKOUT, 0);
        usdt.safeTransferFrom(payer, address(this), amount);
        emit Authorized(id, payer, merchant, amount, expiry, uint32(refundWindow));
    }

    /// @notice Settle some or all authorized USDT to the merchant.
    function capture(bytes32 id, uint256 amount) external nonReentrant {
        Payment storage p = _payments[id];
        address merchant = p.merchant;
        _checkMerchant(merchant);
        if (_actor() != merchant) revert NotAuthorized();
        if (p.flags & CLOSED != 0 || p.payer == address(0)) revert InvalidPayment();
        if (block.timestamp > p.expiry) revert Expired();
        Settlement storage s = _settlements[id];
        uint256 captured = s.captured;
        if (amount == 0 || amount > p.authorized - captured) revert InvalidAmount();
        s.captured = uint64(captured + amount);
        uint40 deadline = p.refundDeadline;
        if (deadline == 0) {
            deadline = _u40(block.timestamp + p.refundWindow);
            p.refundDeadline = deadline;
        }
        (uint256 fee, address recipient) = fees.quote(merchant, CHECKOUT, amount);
        usdt.safeTransfer(merchant, amount - fee);
        if (fee > 0) usdt.safeTransfer(recipient, fee);
        emit Captured(id, amount, fee, deadline, p.refundWindow, recipient);
    }

    /// @notice Transfer USDT in one transaction and open its refund window. Checkout rate.
    function charge(bytes32 id, address merchant, uint256 amount, uint64 refundWindow) external nonReentrant {
        _charge(id, merchant, amount, refundWindow, CHECKOUT);
    }

    /// @notice The same for an invoice the merchant sent: the invoice rate applies.
    function chargeInvoice(bytes32 id, address merchant, uint256 amount, uint64 refundWindow) external nonReentrant {
        _charge(id, merchant, amount, refundWindow, INVOICE);
    }

    function _charge(bytes32 id, address merchant, uint256 amount, uint64 refundWindow, uint8 product) internal {
        _checkMerchant(merchant);
        if (_payments[id].payer != address(0) || merchant == address(0)) revert InvalidPayment();
        if (amount == 0 || refundWindow == 0) revert InvalidAmount();
        address payer = _actor();
        uint40 deadline = _record(id, payer, merchant, amount, _u32(refundWindow), product);
        (uint256 fee, address recipient) = fees.quote(merchant, product, amount);
        usdt.safeTransferFrom(payer, merchant, amount - fee);
        if (fee > 0) usdt.safeTransferFrom(payer, recipient, fee);
        emit Charged(id, payer, merchant, amount, fee, product, deadline, uint32(refundWindow), recipient);
    }

    /// @notice Merchant releases the uncaptured USDT to the payer.
    function void(bytes32 id) external nonReentrant {
        Payment storage p = _payments[id];
        _checkMerchant(p.merchant);
        if (_actor() != p.merchant) revert NotAuthorized();
        if (p.flags & CLOSED != 0 || p.payer == address(0)) revert InvalidPayment();
        uint256 remaining = p.authorized - _captured(id, p);
        p.flags |= CLOSED;
        if (remaining != 0) usdt.safeTransfer(p.payer, remaining);
        emit Voided(id, remaining);
    }

    /// @notice Payer recovers the uncaptured USDT after authorization expiry.
    function reclaim(bytes32 id) external nonReentrant {
        Payment storage p = _payments[id];
        if (_actor() != p.payer || p.payer == address(0)) revert NotAuthorized();
        if (p.flags & CLOSED != 0) revert InvalidPayment();
        if (block.timestamp <= p.expiry) revert TooEarly();
        uint256 remaining = p.authorized - _captured(id, p);
        p.flags |= CLOSED;
        if (remaining != 0) usdt.safeTransfer(p.payer, remaining);
        emit Reclaimed(id, remaining);
    }

    /// @notice Merchant returns captured USDT to the payer within the refund window. The payer gets the
    /// full amount back; Pact's fee on the original payment is not returned.
    function refund(bytes32 id, uint256 amount, bytes32 reason) external nonReentrant {
        Payment storage p = _payments[id];
        _checkMerchant(p.merchant);
        if (_actor() != p.merchant) revert NotAuthorized();
        if (p.payer == address(0)) revert InvalidPayment();
        uint256 deadline = p.refundDeadline;
        if (block.timestamp > deadline || deadline == 0) revert RefundWindowClosed();
        Settlement storage s = _settlements[id];
        uint256 refunded = s.refunded;
        if (amount == 0 || amount > _captured(id, p) - refunded) revert InvalidAmount();
        s.refunded = uint64(refunded + amount);
        usdt.safeTransferFrom(p.merchant, p.payer, amount);
        emit Refunded(id, amount, reason);
    }

    // ------------------------------------------------------------------ one-signature collectors

    /// @notice Take a payment with the payer's EIP-3009 `ReceiveWithAuthorization` signature: `from` the
    /// payer, `to` this escrow, `value` the amount, `nonce` = `authorizationNonce(t)`. Anyone may submit
    /// it; the payer needs no allowance and no WBT.
    function chargeWithAuthorization(
        Terms calldata t,
        uint256 validAfter,
        uint256 validBefore,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        uint40 deadline = _open(t);
        IERC3009(address(usdt)).receiveWithAuthorization(
            t.payer, address(this), t.amount, validAfter, validBefore, authorizationNonce(t), v, r, s
        );
        _payOut(t, deadline);
    }

    /// @notice Take a payment with the payer's Permit2 `PermitWitnessTransferFrom` signature, whose
    /// witness is `hashTerms(t)` and spender this escrow. `erc2612Permit`, when not empty, is
    /// abi.encode(value, deadline, v, r, s) of the payer's USDT permit for Permit2, applied first so a
    /// first payment needs no separate approval transaction.
    function chargeWithPermit2(
        Terms calldata t,
        ISignatureTransfer.PermitTransferFrom calldata permit,
        bytes calldata signature,
        bytes calldata erc2612Permit
    ) external nonReentrant {
        if (permit.permitted.token != address(usdt)) revert InvalidTerms();
        uint40 deadline = _open(t);
        if (erc2612Permit.length != 0) {
            (uint256 value, uint256 permitDeadline, uint8 v, bytes32 r, bytes32 s) =
                abi.decode(erc2612Permit, (uint256, uint256, uint8, bytes32, bytes32));
            // Someone may have submitted this permit already; Permit2 then fails cleanly on its own if
            // no allowance exists, so a failed permit is not an error here.
            try IERC20Permit(address(usdt)).permit(t.payer, address(permit2), value, permitDeadline, v, r, s) {} catch {}
        }
        permit2.permitWitnessTransferFrom(
            permit,
            ISignatureTransfer.SignatureTransferDetails(address(this), t.amount),
            t.payer,
            hashTerms(t),
            PERMIT2_WITNESS_TYPE,
            signature
        );
        _payOut(t, deadline);
    }

    function _open(Terms calldata t) internal returns (uint40) {
        if (t.payer == address(0) || t.merchant == address(0) || t.product > INVOICE) revert InvalidTerms();
        if (t.amount == 0 || t.refundWindow == 0) revert InvalidAmount();
        if (_payments[t.id].payer != address(0)) revert InvalidPayment();
        return _record(t.id, t.payer, t.merchant, t.amount, t.refundWindow, t.product);
    }

    function _payOut(Terms calldata t, uint40 deadline) internal {
        (uint256 fee, address recipient) = fees.quote(t.merchant, t.product, t.amount);
        usdt.safeTransfer(t.merchant, t.amount - fee);
        if (fee > 0) usdt.safeTransfer(recipient, fee);
        emit Charged(t.id, t.payer, t.merchant, t.amount, fee, t.product, deadline, t.refundWindow, recipient);
    }

    // ------------------------------------------------------------------ internal

    /// @dev A charged payment: closed, fully captured, its refund window open from now. Two slots.
    function _record(bytes32 id, address payer, address merchant, uint256 amount, uint32 refundWindow, uint8 product)
        internal
        returns (uint40 deadline)
    {
        deadline = _u40(block.timestamp + refundWindow);
        _payments[id] = Payment(
            payer, _u64(amount), refundWindow, merchant, deadline, uint40(block.timestamp), product, CLOSED | CHARGED
        );
    }

    function _captured(bytes32 id, Payment storage p) internal view returns (uint256) {
        return p.flags & CHARGED != 0 ? p.authorized : _settlements[id].captured;
    }

    function _u64(uint256 value) private pure returns (uint64) {
        if (value > type(uint64).max) revert Overflow();
        return uint64(value);
    }

    function _u40(uint256 value) private pure returns (uint40) {
        if (value > type(uint40).max) revert Overflow();
        return uint40(value);
    }

    function _u32(uint256 value) private pure returns (uint32) {
        if (value > type(uint32).max) revert Overflow();
        return uint32(value);
    }
}
