// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SponsoredContext} from "./SponsoredContext.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";

/// @notice USDT checkout with authorization, capture, release and bounded merchant refunds.
/// @dev Pact's fee comes out of the money that reaches the merchant: on `charge`, `chargeInvoice` and
/// `capture` the merchant receives the amount less the fee its accepted terms set, and the fee goes to
/// the FeeSchedule's recipient. Authorizing, voiding and reclaiming carry no fee. A refund returns the
/// full amount from the merchant's wallet; the Router charges the merchant that call's gas.
contract PaymentEscrow is SponsoredContext, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InvalidPayment();
    error InvalidAmount();
    error NotAuthorized();
    error Expired();
    error TooEarly();
    error RefundWindowClosed();

    struct Payment {
        address payer;
        address merchant;
        uint256 authorized;
        uint256 captured;
        uint256 refunded;
        uint64 expiry;
        uint64 refundDeadline;
        uint64 refundWindow;
        bool closed;
    }

    uint8 private constant CHECKOUT = 0;
    uint8 private constant INVOICE = 1;

    IERC20 public immutable usdt;
    IFeeSchedule public immutable fees;
    mapping(bytes32 => Payment) public payments;

    event Authorized(
        bytes32 indexed id, address indexed payer, address indexed merchant, uint256 amount, uint64 expiry
    );
    event Captured(bytes32 indexed id, uint256 amount, uint256 fee);
    /// @notice `product` is the FeeSchedule product the fee followed: 0 checkout, 1 invoice.
    event Charged(
        bytes32 indexed id, address indexed payer, address indexed merchant, uint256 amount, uint256 fee, uint8 product
    );
    event Voided(bytes32 indexed id, uint256 amount);
    event Reclaimed(bytes32 indexed id, uint256 amount);
    event Refunded(bytes32 indexed id, uint256 amount, bytes32 reason);

    constructor(IERC20 usdt_, address router_, IFeeSchedule fees_) SponsoredContext(router_) {
        if (address(usdt_) == address(0) || address(fees_) == address(0)) revert InvalidPayment();
        usdt = usdt_;
        fees = fees_;
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
            merchant = payments[id].merchant;
            amount = value;
        } else if (selector == this.refund.selector) {
            (bytes32 id, uint256 value,) = abi.decode(data[4:], (bytes32, uint256, bytes32));
            merchant = payments[id].merchant;
            amount = value;
        } else if (selector == this.void.selector || selector == this.reclaim.selector) {
            bytes32 id = abi.decode(data[4:], (bytes32));
            Payment storage p = payments[id];
            merchant = p.merchant;
            amount = p.authorized - p.captured;
        } else {
            revert InvalidPayment();
        }
    }

    /// @notice Lock payer USDT until capture, void, or expiry.
    function authorize(bytes32 id, address merchant, uint256 amount, uint64 expiry, uint64 refundWindow)
        external
        nonReentrant
    {
        _checkMerchant(merchant);
        if (payments[id].payer != address(0) || merchant == address(0)) revert InvalidPayment();
        if (amount == 0 || refundWindow == 0) revert InvalidAmount();
        if (expiry <= block.timestamp) revert Expired();
        address payer = _actor();
        payments[id] = Payment(payer, merchant, amount, 0, 0, expiry, 0, refundWindow, false);
        usdt.safeTransferFrom(payer, address(this), amount);
        emit Authorized(id, payer, merchant, amount, expiry);
    }

    /// @notice Settle some or all authorized USDT to the merchant.
    function capture(bytes32 id, uint256 amount) external nonReentrant {
        Payment storage p = payments[id];
        _checkMerchant(p.merchant);
        if (_actor() != p.merchant) revert NotAuthorized();
        if (p.closed || p.payer == address(0)) revert InvalidPayment();
        if (block.timestamp > p.expiry) revert Expired();
        if (amount == 0 || amount > p.authorized - p.captured) revert InvalidAmount();
        p.captured += amount;
        if (p.refundDeadline == 0) p.refundDeadline = uint64(block.timestamp + p.refundWindow);
        uint256 fee = fees.feeFor(p.merchant, CHECKOUT, amount);
        usdt.safeTransfer(p.merchant, amount - fee);
        if (fee > 0) usdt.safeTransfer(fees.recipient(), fee);
        emit Captured(id, amount, fee);
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
        if (payments[id].payer != address(0) || merchant == address(0)) revert InvalidPayment();
        if (amount == 0 || refundWindow == 0) revert InvalidAmount();
        address payer = _actor();
        payments[id] = Payment(
            payer,
            merchant,
            amount,
            amount,
            0,
            uint64(block.timestamp),
            uint64(block.timestamp + refundWindow),
            refundWindow,
            true
        );
        uint256 fee = fees.feeFor(merchant, product, amount);
        usdt.safeTransferFrom(payer, merchant, amount - fee);
        if (fee > 0) usdt.safeTransferFrom(payer, fees.recipient(), fee);
        emit Charged(id, payer, merchant, amount, fee, product);
    }

    /// @notice Merchant releases the uncaptured USDT to the payer.
    function void(bytes32 id) external nonReentrant {
        Payment storage p = payments[id];
        _checkMerchant(p.merchant);
        if (_actor() != p.merchant) revert NotAuthorized();
        if (p.closed || p.payer == address(0)) revert InvalidPayment();
        uint256 remaining = p.authorized - p.captured;
        p.closed = true;
        if (remaining != 0) usdt.safeTransfer(p.payer, remaining);
        emit Voided(id, remaining);
    }

    /// @notice Payer recovers the uncaptured USDT after authorization expiry.
    function reclaim(bytes32 id) external nonReentrant {
        Payment storage p = payments[id];
        if (_actor() != p.payer || p.payer == address(0)) revert NotAuthorized();
        if (p.closed) revert InvalidPayment();
        if (block.timestamp <= p.expiry) revert TooEarly();
        uint256 remaining = p.authorized - p.captured;
        p.closed = true;
        if (remaining != 0) usdt.safeTransfer(p.payer, remaining);
        emit Reclaimed(id, remaining);
    }

    /// @notice Merchant returns captured USDT to the payer within the refund window. The payer gets the
    /// full amount back; Pact's fee on the original payment is not returned.
    function refund(bytes32 id, uint256 amount, bytes32 reason) external nonReentrant {
        Payment storage p = payments[id];
        _checkMerchant(p.merchant);
        if (_actor() != p.merchant) revert NotAuthorized();
        if (p.payer == address(0)) revert InvalidPayment();
        if (block.timestamp > p.refundDeadline || p.refundDeadline == 0) revert RefundWindowClosed();
        if (amount == 0 || amount > p.captured - p.refunded) revert InvalidAmount();
        p.refunded += amount;
        usdt.safeTransferFrom(p.merchant, p.payer, amount);
        emit Refunded(id, amount, reason);
    }
}
