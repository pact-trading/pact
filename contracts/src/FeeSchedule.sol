// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Signatures} from "./Signatures.sol";

/// @notice What payment contracts read to take Pact's fee out of a payment.
interface IFeeSchedule {
    /// @notice The fee on `amount` paid to `merchant`, under the terms the merchant accepted.
    function feeFor(address merchant, uint8 product, uint256 amount) external view returns (uint256);
    /// @notice `wbtWei` of gas converted to USDT base units, rounded up.
    function gasFee(uint256 wbtWei) external view returns (uint256);
    /// @notice Where every fee is sent.
    function recipient() external view returns (address);
}

/// @notice Pact's fee terms, one numbered version at a time. A merchant accepts a version by
/// signature, and payment contracts charge only under the version the merchant accepted, so neither
/// a payer nor Pact can raise a merchant's fee on its own. Pact's whole fee, gas included, comes out
/// of the payment: `feeFor` is a percentage with a floor and an optional ceiling, never more than
/// the payment itself. `gasFee` converts gas to USDT at a price the owner or a bounded keeper sets;
/// it prices calls where the merchant sends money (refunds, buy-backs) and pays their gas on top.
contract FeeSchedule is IFeeSchedule, EIP712 {
    error NotOwner();
    error NotAuthorized();
    error InvalidTerms();
    error InvalidAddress();
    error InvalidProduct();
    error UnknownVersion();
    error TermsNotAccepted();
    error FeeExceedsAmount();
    error InvalidSignature();
    error SignatureExpired();
    error InvalidPrice();
    error PriceTooSoon();
    error PriceStepTooLarge();

    /// @notice A product's rate: `bps` of the amount, at least `minFee`, at most `maxFee` (0: no cap).
    struct Rate {
        uint16 bps;
        uint64 minFee;
        uint64 maxFee;
    }

    struct Terms {
        Rate checkout;
        Rate invoice;
    }

    uint8 public constant CHECKOUT = 0;
    uint8 public constant INVOICE = 1;
    uint16 public constant MAX_BPS = 500;
    /// @dev Every payment the Router sponsors is at least 1 USDT, so a floor up to 1 USDT always fits.
    uint64 public constant MAX_MIN_FEE = 1_000_000;
    uint16 public constant MAX_PRICE_STEP_BPS = 2_000;
    uint64 public constant MIN_PRICE_INTERVAL = 10 minutes;
    bytes32 public constant ACCEPT_TYPEHASH =
        keccak256("AcceptTerms(address merchant,uint32 version,uint256 nonce,uint256 deadline)");

    address public owner;
    address public pendingOwner;
    address public recipient;
    address public priceKeeper;
    /// @notice USDT base units per 1 WBT (10^18 wei).
    uint256 public usdtPerWBT;
    uint64 public priceUpdatedAt;
    uint32 public latestVersion;
    mapping(uint32 => Terms) private _terms;
    mapping(address => uint32) public acceptedVersion;
    mapping(address => uint256) public nonces;

    event TermsPublished(uint32 indexed version, Terms terms);
    event TermsAccepted(address indexed merchant, uint32 indexed version);
    event RecipientSet(address indexed recipient);
    event PriceKeeperSet(address indexed keeper);
    event PriceSet(uint256 usdtPerWBT, address indexed by);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    constructor(address recipient_, address priceKeeper_, uint256 usdtPerWBT_, Terms memory initial)
        EIP712("Pact Fees", "1")
    {
        if (recipient_ == address(0)) revert InvalidAddress();
        if (usdtPerWBT_ == 0) revert InvalidPrice();
        owner = msg.sender;
        recipient = recipient_;
        priceKeeper = priceKeeper_;
        usdtPerWBT = usdtPerWBT_;
        priceUpdatedAt = uint64(block.timestamp);
        emit OwnershipTransferred(address(0), msg.sender);
        emit RecipientSet(recipient_);
        emit PriceKeeperSet(priceKeeper_);
        emit PriceSet(usdtPerWBT_, msg.sender);
        _publish(initial);
    }

    // ------------------------------------------------------------------ terms

    /// @notice Publish a new version. Merchants keep their accepted version until they sign the new one.
    function publish(Terms calldata t) external onlyOwner returns (uint32) {
        return _publish(t);
    }

    function terms(uint32 version) external view returns (Terms memory) {
        if (version == 0 || version > latestVersion) revert UnknownVersion();
        return _terms[version];
    }

    /// @notice The merchant accepts the latest version from its own wallet.
    function accept(uint32 version) external {
        _accept(msg.sender, version);
    }

    /// @notice The merchant's signed acceptance (EIP-712 `AcceptTerms`), submitted by anyone.
    function acceptWithSig(address merchant, uint32 version, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        if (!Signatures.isValid(merchant, hashAcceptance(merchant, version, nonces[merchant], deadline), signature)) {
            revert InvalidSignature();
        }
        nonces[merchant]++;
        _accept(merchant, version);
    }

    function hashAcceptance(address merchant, uint32 version, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(keccak256(abi.encode(ACCEPT_TYPEHASH, merchant, version, nonce, deadline)));
    }

    function feeFor(address merchant, uint8 product, uint256 amount) external view returns (uint256 fee) {
        uint32 version = acceptedVersion[merchant];
        if (version == 0) revert TermsNotAccepted();
        Rate memory r = _rate(_terms[version], product);
        fee = (amount * r.bps + 9_999) / 10_000;
        if (fee < r.minFee) fee = r.minFee;
        if (r.maxFee != 0 && fee > r.maxFee) fee = r.maxFee;
        if (fee > amount) revert FeeExceedsAmount();
    }

    function _publish(Terms memory t) internal returns (uint32 version) {
        _validate(t.checkout);
        _validate(t.invoice);
        version = ++latestVersion;
        _terms[version] = t;
        emit TermsPublished(version, t);
    }

    function _validate(Rate memory r) internal pure {
        if (r.bps > MAX_BPS || r.minFee > MAX_MIN_FEE || (r.maxFee != 0 && r.maxFee < r.minFee)) {
            revert InvalidTerms();
        }
    }

    function _accept(address merchant, uint32 version) internal {
        if (merchant == address(0)) revert InvalidAddress();
        // Only the latest version can be accepted: a merchant signs exactly the terms it reviewed.
        if (version == 0 || version != latestVersion) revert UnknownVersion();
        acceptedVersion[merchant] = version;
        emit TermsAccepted(merchant, version);
    }

    function _rate(Terms storage t, uint8 product) internal view returns (Rate memory) {
        if (product == CHECKOUT) return t.checkout;
        if (product == INVOICE) return t.invoice;
        revert InvalidProduct();
    }

    // ------------------------------------------------------------------ gas price

    function gasFee(uint256 wbtWei) external view returns (uint256) {
        return (wbtWei * usdtPerWBT + 1e18 - 1) / 1e18;
    }

    /// @notice The owner sets any price; the keeper moves it at most 20% per update, at most every 10 minutes.
    function setPrice(uint256 usdtPerWBT_) external {
        if (usdtPerWBT_ == 0) revert InvalidPrice();
        if (msg.sender != owner) {
            if (msg.sender != priceKeeper) revert NotAuthorized();
            if (block.timestamp < uint256(priceUpdatedAt) + MIN_PRICE_INTERVAL) revert PriceTooSoon();
            uint256 current = usdtPerWBT;
            uint256 step = usdtPerWBT_ > current ? usdtPerWBT_ - current : current - usdtPerWBT_;
            if (step * 10_000 > current * MAX_PRICE_STEP_BPS) revert PriceStepTooLarge();
        }
        usdtPerWBT = usdtPerWBT_;
        priceUpdatedAt = uint64(block.timestamp);
        emit PriceSet(usdtPerWBT_, msg.sender);
    }

    // ------------------------------------------------------------------ admin

    function setRecipient(address recipient_) external onlyOwner {
        if (recipient_ == address(0)) revert InvalidAddress();
        recipient = recipient_;
        emit RecipientSet(recipient_);
    }

    function setPriceKeeper(address keeper) external onlyOwner {
        priceKeeper = keeper;
        emit PriceKeeperSet(keeper);
    }

    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotAuthorized();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }
}
