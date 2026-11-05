// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SponsoredContext} from "./SponsoredContext.sol";

/// @notice Dual-consent recurring mandates with payer-signed, independently relayed cancellation.
/// @dev Separately deployed V2; V1 mandate IDs and signatures are not migrated implicitly.
contract SubscriptionManagerV2 is SponsoredContext, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InvalidMandate();
    error InvalidSignature();
    error NotAuthorized();
    error InvalidConsent();
    error ExpiredCancellation();

    enum Refusal {
        Cancelled,
        Expired,
        TooEarly,
        CapExceeded,
        MaxPeriods,
        InsufficientFunds,
        TransferFailed
    }

    struct Mandate {
        address payer;
        address merchant;
        bytes32 planId;
        uint256 amountCap;
        uint64 periodSeconds;
        uint32 maxPeriods;
        uint64 endTime;
        uint256 nonce;
    }

    struct Subscription {
        address payer;
        address merchant;
        bytes32 planId;
        uint256 amountCap;
        uint64 periodSeconds;
        uint32 maxPeriods;
        uint32 chargedPeriods;
        uint64 endTime;
        uint64 nextChargeAt;
        bool cancelled;
    }

    bytes32 public constant MANDATE_TYPEHASH = keccak256(
        "Mandate(address payer,address merchant,bytes32 planId,uint256 amountCap,uint64 periodSeconds,uint32 maxPeriods,uint64 endTime,uint256 nonce)"
    );
    bytes32 public constant CONSENT_TYPEHASH = keccak256("SponsorshipConsent(bytes32 mandateHash,uint64 deadline)");
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 id,uint64 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    IERC20 public immutable usdt;
    address public owner;
    address public keeper;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => Subscription) public subscriptions;
    mapping(address => mapping(bytes32 => bool)) public revokedConsents;

    event Subscribed(bytes32 indexed id, address indexed payer, address indexed merchant, bytes32 planId);
    event Charged(bytes32 indexed id, uint256 amount, uint32 period);
    event Refused(bytes32 indexed id, Refusal reason);
    event Cancelled(bytes32 indexed id);
    event Replaced(bytes32 indexed oldId, bytes32 indexed newId);
    event ConsentRevoked(address indexed merchant, bytes32 indexed mandateHash);

    constructor(IERC20 usdt_, address router_, address keeper_) SponsoredContext(router_) {
        if (address(usdt_) == address(0)) revert InvalidMandate();
        usdt = usdt_;
        owner = msg.sender;
        keeper = keeper_;
    }

    /// @notice Return the merchant and economic amount committed by sponsored calldata.
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount) {
        if (data.length < 4) revert InvalidMandate();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.subscribe.selector) {
            (Mandate memory m,, uint64 deadline, bytes memory consent) =
                abi.decode(data[4:], (Mandate, bytes, uint64, bytes));
            _checkConsent(m, deadline, consent);
            return (m.merchant, m.amountCap);
        }
        if (selector == this.replace.selector) {
            (, Mandate memory m,, uint64 deadline, bytes memory consent) =
                abi.decode(data[4:], (bytes32, Mandate, bytes, uint64, bytes));
            _checkConsent(m, deadline, consent);
            return (m.merchant, m.amountCap);
        }
        if (selector == this.charge.selector) {
            (bytes32 id, uint256 value) = abi.decode(data[4:], (bytes32, uint256));
            return (subscriptions[id].merchant, value);
        }
        if (selector == this.cancel.selector) {
            bytes32 id = abi.decode(data[4:], (bytes32));
            return (subscriptions[id].merchant, subscriptions[id].amountCap);
        }
        revert InvalidMandate();
    }

    /// @notice Assign the renewal keeper.
    function setKeeper(address keeper_) external {
        if (msg.sender != owner) revert NotAuthorized();
        keeper = keeper_;
    }

    /// @notice Domain separator for signed mandates.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Settle Subscription")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Hash a mandate for EIP-712 signing.
    function hashMandate(Mandate memory m) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                MANDATE_TYPEHASH,
                m.payer,
                m.merchant,
                m.planId,
                m.amountCap,
                m.periodSeconds,
                m.maxPeriods,
                m.endTime,
                m.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    function hashConsent(Mandate memory m, uint64 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked(
                "\x19\x01", domainSeparator(), keccak256(abi.encode(CONSENT_TYPEHASH, hashMandate(m), deadline))
            )
        );
    }

    /// @notice A merchant can revoke an unused signed mandate authorization.
    /// @dev Existing subscriptions retain their payer cancellation and renewal terms.
    function revokeConsent(bytes32 mandateHash) external {
        revokedConsents[msg.sender][mandateHash] = true;
        emit ConsentRevoked(msg.sender, mandateHash);
    }

    function _checkConsent(Mandate memory m, uint64 deadline, bytes memory consent) private view {
        if (
            m.merchant == address(0) || deadline < block.timestamp || deadline > m.endTime
                || revokedConsents[m.merchant][hashMandate(m)]
        ) revert InvalidConsent();
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(hashConsent(m, deadline), consent);
        if (error != ECDSA.RecoverError.NoError || signer != m.merchant) revert InvalidConsent();
    }

    /// @notice Anyone may submit the exact mandate approved by both payer and merchant.
    function subscribe(
        Mandate calldata m,
        bytes calldata signature,
        uint64 consentDeadline,
        bytes calldata merchantSignature
    ) external nonReentrant returns (bytes32) {
        return _subscribe(m, signature, consentDeadline, merchantSignature);
    }

    function _subscribe(
        Mandate calldata m,
        bytes calldata signature,
        uint64 consentDeadline,
        bytes calldata merchantSignature
    ) internal returns (bytes32 id) {
        _checkMerchant(m.merchant);
        _checkConsent(m, consentDeadline, merchantSignature);
        if (
            m.payer == address(0) || m.merchant == address(0) || m.amountCap == 0 || m.periodSeconds == 0
                || m.maxPeriods == 0 || m.endTime <= block.timestamp || m.nonce != nonces[m.payer]
        ) revert InvalidMandate();
        if (ECDSA.recover(hashMandate(m), signature) != m.payer) revert InvalidSignature();
        id = keccak256(abi.encode(m.payer, m.nonce, address(this)));
        nonces[m.payer]++;
        subscriptions[id] = Subscription(
            m.payer,
            m.merchant,
            m.planId,
            m.amountCap,
            m.periodSeconds,
            m.maxPeriods,
            0,
            m.endTime,
            uint64(block.timestamp),
            false
        );
        emit Subscribed(id, m.payer, m.merchant, m.planId);
    }

    /// @notice Pull one renewal; policy refusals emit a reason and return false.
    function charge(bytes32 id, uint256 amount) external nonReentrant returns (bool) {
        Subscription storage s = subscriptions[id];
        _checkMerchant(s.merchant);
        if (s.payer == address(0)) revert InvalidMandate();
        if (_actor() != s.merchant && msg.sender != keeper) revert NotAuthorized();
        if (s.cancelled) return _refuse(id, Refusal.Cancelled);
        if (block.timestamp > s.endTime) return _refuse(id, Refusal.Expired);
        if (s.chargedPeriods >= s.maxPeriods) return _refuse(id, Refusal.MaxPeriods);
        if (block.timestamp < s.nextChargeAt) return _refuse(id, Refusal.TooEarly);
        if (amount == 0 || amount > s.amountCap) return _refuse(id, Refusal.CapExceeded);
        if (usdt.balanceOf(s.payer) < amount || usdt.allowance(s.payer, address(this)) < amount) {
            return _refuse(id, Refusal.InsufficientFunds);
        }
        // Optional return supports USDT-style tokens; a failed token call creates a durable refusal.
        (bool success, bytes memory data) =
            address(usdt).call(abi.encodeCall(IERC20.transferFrom, (s.payer, s.merchant, amount)));
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            return _refuse(id, Refusal.TransferFailed);
        }
        s.chargedPeriods++;
        s.nextChargeAt = uint64(block.timestamp + s.periodSeconds);
        emit Charged(id, amount, s.chargedPeriods);
        return true;
    }

    function _refuse(bytes32 id, Refusal reason) internal returns (bool) {
        emit Refused(id, reason);
        return false;
    }

    /// @notice Payer cancels immediately, including a router-sponsored cancellation.
    function cancel(bytes32 id) external nonReentrant {
        Subscription storage s = subscriptions[id];
        _checkMerchant(s.merchant);
        if (s.payer == address(0) || _actor() != s.payer) revert NotAuthorized();
        if (s.cancelled) revert InvalidMandate();
        s.cancelled = true;
        emit Cancelled(id);
    }

    function hashCancellation(bytes32 id, uint64 deadline) public view returns (bytes32) {
        return keccak256(
            abi.encodePacked("\x19\x01", domainSeparator(), keccak256(abi.encode(CANCEL_TYPEHASH, id, deadline)))
        );
    }

    /// @notice Relayers may cancel with payer consent even when merchant sponsorship is unavailable.
    /// @dev No token movement, merchant fee or tank debit. The submitting relayer pays network gas.
    function cancelWithSignature(bytes32 id, uint64 deadline, bytes calldata signature) external nonReentrant {
        if (deadline < block.timestamp) revert ExpiredCancellation();
        Subscription storage s = subscriptions[id];
        if (s.payer == address(0) || s.cancelled) revert InvalidMandate();
        (address signer, ECDSA.RecoverError error,) = ECDSA.tryRecover(hashCancellation(id, deadline), signature);
        if (error != ECDSA.RecoverError.NoError || signer != s.payer) revert InvalidSignature();
        s.cancelled = true;
        emit Cancelled(id);
    }

    /// @notice Payer swaps a mandate atomically with a newly signed mandate.
    function replace(
        bytes32 oldId,
        Mandate calldata m,
        bytes calldata signature,
        uint64 consentDeadline,
        bytes calldata merchantSignature
    ) external nonReentrant returns (bytes32 newId) {
        Subscription storage old = subscriptions[oldId];
        _checkMerchant(old.merchant);
        if (
            old.payer == address(0) || old.cancelled || _actor() != old.payer || m.payer != old.payer
                || m.merchant != old.merchant
        ) {
            revert NotAuthorized();
        }
        newId = _subscribe(m, signature, consentDeadline, merchantSignature);
        old.cancelled = true;
        emit Cancelled(oldId);
        emit Replaced(oldId, newId);
    }
}
