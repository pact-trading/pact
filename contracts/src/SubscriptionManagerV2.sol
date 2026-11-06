// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {SponsoredContext, IRouterContext} from "./SponsoredContext.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";

/// @notice Payer-signed recurring mandates with payer-signed, independently relayed cancellation.
/// @dev Each successful renewal pays the merchant the amount less Pact's checkout fee, under the terms
/// the merchant accepted in the FeeSchedule. Subscribing, replacing and cancelling carry no fee, and
/// Pact's relayer pays their gas, so registering needs no merchant signature: a subscription only ever
/// moves the payer's money to the merchant, within the payer's signed cap.
///
/// v3: a subscription is four storage slots and a renewal updates one; a renewal moves the money in
/// two transfers (payer to merchant, payer to fee recipient) that succeed or fail together; the keeper
/// renews many subscriptions in one transaction with `chargeBatch`; `subscribeWithPermit` sets the
/// payer's allowance and registers in one transaction.
contract SubscriptionManagerV2 is SponsoredContext, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error InvalidMandate();
    error InvalidSignature();
    error NotAuthorized();
    error ExpiredCancellation();

    /// @dev Append only: the API maps these by position.
    enum Refusal {
        Cancelled,
        Expired,
        TooEarly,
        CapExceeded,
        MaxPeriods,
        InsufficientFunds,
        TransferFailed,
        FeeUnavailable,
        /// In a batch: the caller may not renew this subscription (`charge` reverts instead).
        NotAuthorized,
        /// In a batch: no such subscription (`charge` reverts instead).
        UnknownSubscription
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

    /// @dev Slot 0 (all a renewal writes): payer, next charge, periods charged. Slot 1: merchant, end,
    /// period limit. Slot 2: plan. Slot 3: cap, period, cancelled.
    struct Subscription {
        address payer;
        uint64 nextChargeAt;
        uint32 chargedPeriods;
        address merchant;
        uint64 endTime;
        uint32 maxPeriods;
        bytes32 planId;
        uint128 amountCap;
        uint64 periodSeconds;
        bool cancelled;
    }

    struct SubscriptionView {
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
    bytes32 private constant NAME_HASH = keccak256("Settle Subscription");
    bytes32 private constant VERSION_HASH = keccak256("2");
    uint8 private constant CHECKOUT = 0;

    uint256 private immutable _cachedChainId;
    bytes32 private immutable _cachedDomainSeparator;
    IERC20 public immutable usdt;
    IFeeSchedule public immutable fees;
    address public owner;
    address public keeper;
    mapping(address => uint256) public nonces;
    mapping(bytes32 => Subscription) private _subscriptions;

    event Subscribed(bytes32 indexed id, address indexed payer, address indexed merchant, bytes32 planId);
    event Charged(
        bytes32 indexed id, uint256 amount, uint32 period, uint256 fee, uint64 nextChargeAt, address feeRecipient
    );
    event Refused(bytes32 indexed id, Refusal reason);
    event Cancelled(bytes32 indexed id);
    event Replaced(bytes32 indexed oldId, bytes32 indexed newId);

    constructor(IERC20 usdt_, address router_, address keeper_, IFeeSchedule fees_) SponsoredContext(router_) {
        if (address(usdt_) == address(0) || address(fees_) == address(0)) revert InvalidMandate();
        usdt = usdt_;
        fees = fees_;
        owner = msg.sender;
        keeper = keeper_;
        _cachedChainId = block.chainid;
        _cachedDomainSeparator = _buildDomainSeparator();
    }

    /// @notice A subscription as stored.
    function subscription(bytes32 id) external view returns (SubscriptionView memory v) {
        Subscription storage s = _subscriptions[id];
        v = SubscriptionView(
            s.payer,
            s.merchant,
            s.planId,
            s.amountCap,
            s.periodSeconds,
            s.maxPeriods,
            s.chargedPeriods,
            s.endTime,
            s.nextChargeAt,
            s.cancelled
        );
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
            return (_subscriptions[id].merchant, value);
        }
        if (selector == this.cancel.selector) {
            bytes32 id = abi.decode(data[4:], (bytes32));
            return (_subscriptions[id].merchant, _subscriptions[id].amountCap);
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
        return block.chainid == _cachedChainId ? _cachedDomainSeparator : _buildDomainSeparator();
    }

    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
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

    /// @notice `subscribe`, after applying the payer's EIP-2612 USDT permit for this contract, so the
    /// allowance renewals spend and the registration take one transaction. A permit someone already
    /// submitted is not an error: renewals then use the allowance it set.
    function subscribeWithPermit(
        Mandate calldata m,
        bytes calldata signature,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (bytes32) {
        try IERC20Permit(address(usdt)).permit(m.payer, address(this), value, deadline, v, r, s) {} catch {}
        return _subscribe(m, signature);
    }

    function _subscribe(Mandate calldata m, bytes calldata signature) internal returns (bytes32 id) {
        _checkMerchant(m.merchant);
        if (
            m.payer == address(0) || m.merchant == address(0) || m.amountCap == 0 || m.periodSeconds == 0
                || m.maxPeriods == 0 || m.endTime <= block.timestamp || m.nonce != nonces[m.payer]
                || m.amountCap > type(uint128).max
        ) revert InvalidMandate();
        if (ECDSA.recover(hashMandate(m), signature) != m.payer) revert InvalidSignature();
        id = keccak256(abi.encode(m.payer, m.nonce, address(this)));
        nonces[m.payer]++;
        _subscriptions[id] = Subscription(
            m.payer,
            uint64(block.timestamp),
            0,
            m.merchant,
            m.endTime,
            m.maxPeriods,
            m.planId,
            uint128(m.amountCap),
            m.periodSeconds,
            false
        );
        emit Subscribed(id, m.payer, m.merchant, m.planId);
    }

    /// @notice Pull one renewal; policy refusals emit a reason and return false. The merchant receives
    /// the amount less Pact's fee.
    function charge(bytes32 id, uint256 amount) external nonReentrant returns (bool) {
        Subscription storage s = _subscriptions[id];
        _checkMerchant(s.merchant);
        if (s.payer == address(0)) revert InvalidMandate();
        if (_actor() != s.merchant && msg.sender != keeper) revert NotAuthorized();
        return _renew(id, s, amount);
    }

    /// @notice Pull many renewals in one transaction, each under `charge`'s rules for the caller. One
    /// item never affects another: anything `charge` would revert on is refused here instead
    /// (`NotAuthorized`, `UnknownSubscription`) and the batch goes on.
    function chargeBatch(bytes32[] calldata ids, uint256[] calldata amounts)
        external
        nonReentrant
        returns (bool[] memory charged)
    {
        if (ids.length != amounts.length) revert InvalidMandate();
        charged = new bool[](ids.length);
        bool isKeeper = msg.sender == keeper;
        bool viaRouter = msg.sender == router;
        address actor = _actor();
        address routedMerchant = viaRouter ? IRouterContext(router).activeMerchant() : address(0);
        for (uint256 i; i < ids.length; ++i) {
            Subscription storage s = _subscriptions[ids[i]];
            address merchant = s.merchant;
            if (s.payer == address(0)) {
                _refuse(ids[i], Refusal.UnknownSubscription);
            } else if ((viaRouter && routedMerchant != merchant) || (actor != merchant && !isKeeper)) {
                _refuse(ids[i], Refusal.NotAuthorized);
            } else {
                charged[i] = _renew(ids[i], s, amounts[i]);
            }
        }
    }

    function _renew(bytes32 id, Subscription storage s, uint256 amount) internal returns (bool) {
        if (s.cancelled) return _refuse(id, Refusal.Cancelled);
        if (block.timestamp > s.endTime) return _refuse(id, Refusal.Expired);
        if (s.chargedPeriods >= s.maxPeriods) return _refuse(id, Refusal.MaxPeriods);
        if (block.timestamp < s.nextChargeAt) return _refuse(id, Refusal.TooEarly);
        if (amount == 0 || amount > s.amountCap) return _refuse(id, Refusal.CapExceeded);
        address payer = s.payer;
        if (usdt.balanceOf(payer) < amount || usdt.allowance(payer, address(this)) < amount) {
            return _refuse(id, Refusal.InsufficientFunds);
        }
        uint256 fee;
        address recipient;
        try fees.quote(s.merchant, CHECKOUT, amount) returns (uint256 f, address to) {
            (fee, recipient) = (f, to);
        } catch {
            return _refuse(id, Refusal.FeeUnavailable);
        }
        uint32 period = s.chargedPeriods + 1;
        uint64 next = uint64(block.timestamp + s.periodSeconds);
        // The period update and both transfers run in one call frame: a token failure undoes all of
        // it, and the renewal is refused instead of half-paid.
        try this.settleRenewal(id, payer, s.merchant, amount - fee, recipient, fee, period, next) {}
        catch {
            return _refuse(id, Refusal.TransferFailed);
        }
        emit Charged(id, amount, period, fee, next, recipient);
        return true;
    }

    /// @notice Internal step of a renewal, callable only by this contract.
    function settleRenewal(
        bytes32 id,
        address payer,
        address merchant,
        uint256 net,
        address recipient,
        uint256 fee,
        uint32 period,
        uint64 next
    ) external {
        if (msg.sender != address(this)) revert NotAuthorized();
        Subscription storage s = _subscriptions[id];
        s.chargedPeriods = period;
        s.nextChargeAt = next;
        usdt.safeTransferFrom(payer, merchant, net);
        if (fee > 0) usdt.safeTransferFrom(payer, recipient, fee);
    }

    function _refuse(bytes32 id, Refusal reason) internal returns (bool) {
        emit Refused(id, reason);
        return false;
    }

    /// @notice Payer cancels immediately, including a router-sponsored cancellation.
    function cancel(bytes32 id) external nonReentrant {
        Subscription storage s = _subscriptions[id];
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
        Subscription storage s = _subscriptions[id];
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
        Subscription storage old = _subscriptions[oldId];
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
