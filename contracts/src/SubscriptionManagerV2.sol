// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SponsoredContext} from "./SponsoredContext.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";

/// @notice Payer-signed recurring mandates with payer-signed, independently relayed cancellation.
/// @dev Each successful renewal pays the merchant the amount less Pact's checkout fee, under the terms
/// the merchant accepted in the FeeSchedule. Subscribing, replacing and cancelling carry no fee, and
/// Pact's relayer pays their gas, so registering needs no merchant signature: a subscription only ever
/// moves the payer's money to the merchant, within the payer's signed cap.
contract SubscriptionManagerV2 is SponsoredContext, ReentrancyGuard {
    using SafeERC20 for IERC20;
    error InvalidMandate();
    error InvalidSignature();
    error NotAuthorized();
    error ExpiredCancellation();

    enum Refusal {
        Cancelled,
        Expired,
        TooEarly,
        CapExceeded,
        MaxPeriods,
        InsufficientFunds,
        TransferFailed,
        FeeUnavailable
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
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(bytes32 id,uint64 deadline)");
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint8 private constant CHECKOUT = 0;

    IERC20 public immutable usdt;
    IFeeSchedule public immutable fees;
    address public owner;
    address public keeper;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => Subscription) public subscriptions;

    event Subscribed(bytes32 indexed id, address indexed payer, address indexed merchant, bytes32 planId);
    event Charged(bytes32 indexed id, uint256 amount, uint32 period, uint256 fee);
    event Refused(bytes32 indexed id, Refusal reason);
    event Cancelled(bytes32 indexed id);
    event Replaced(bytes32 indexed oldId, bytes32 indexed newId);

    constructor(IERC20 usdt_, address router_, address keeper_, IFeeSchedule fees_) SponsoredContext(router_) {
        if (address(usdt_) == address(0) || address(fees_) == address(0)) revert InvalidMandate();
        usdt = usdt_;
        fees = fees_;
        owner = msg.sender;
        keeper = keeper_;
    }

    /// @notice Return the merchant and economic amount committed by sponsored calldata.
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount) {
        if (data.length < 4) revert InvalidMandate();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.subscribe.selector) {
            (Mandate memory m,) = abi.decode(data[4:], (Mandate, bytes));
            return (m.merchant, m.amountCap);
        }
        if (selector == this.replace.selector) {
            (, Mandate memory m,) = abi.decode(data[4:], (bytes32, Mandate, bytes));
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

    /// @notice Anyone may submit the exact mandate the payer signed.
    function subscribe(Mandate calldata m, bytes calldata signature) external nonReentrant returns (bytes32) {
        return _subscribe(m, signature);
    }

    function _subscribe(Mandate calldata m, bytes calldata signature) internal returns (bytes32 id) {
        _checkMerchant(m.merchant);
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

    /// @notice Pull one renewal; policy refusals emit a reason and return false. The merchant receives
    /// the amount less Pact's fee.
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
        uint256 fee;
        try fees.feeFor(s.merchant, CHECKOUT, amount) returns (uint256 f) {
            fee = f;
        } catch {
            return _refuse(id, Refusal.FeeUnavailable);
        }
        // Optional return supports USDT-style tokens; a failed token call creates a durable refusal.
        (bool success, bytes memory data) =
            address(usdt).call(abi.encodeCall(IERC20.transferFrom, (s.payer, address(this), amount)));
        if (!success || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) {
            return _refuse(id, Refusal.TransferFailed);
        }
        s.chargedPeriods++;
        s.nextChargeAt = uint64(block.timestamp + s.periodSeconds);
        usdt.safeTransfer(s.merchant, amount - fee);
        if (fee > 0) usdt.safeTransfer(fees.recipient(), fee);
        emit Charged(id, amount, s.chargedPeriods, fee);
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

    /// @notice Anyone may submit the payer's signed cancellation, so cancelling needs no gas from the payer.
    /// @dev No token movement and no fee. The submitting relayer pays network gas.
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
    function replace(bytes32 oldId, Mandate calldata m, bytes calldata signature)
        external
        nonReentrant
        returns (bytes32 newId)
    {
        Subscription storage old = subscriptions[oldId];
        _checkMerchant(old.merchant);
        if (
            old.payer == address(0) || old.cancelled || _actor() != old.payer || m.payer != old.payer
                || m.merchant != old.merchant
        ) {
            revert NotAuthorized();
        }
        newId = _subscribe(m, signature);
        old.cancelled = true;
        emit Cancelled(oldId);
        emit Replaced(oldId, newId);
    }
}
