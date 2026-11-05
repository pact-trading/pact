// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {ISignatureTransfer} from "../x402-reference/src/interfaces/ISignatureTransfer.sol";
import {Router, ISponsoredTarget} from "./Router.sol";
import {X402AccountFactory} from "./X402AccountFactory.sol";
import {X402AgentAccount} from "./X402AgentAccount.sol";

// Exact official ABI shapes; Permit2 spender remains the canonical proxy, never this gateway.
interface IX402ExactProxy {
    struct Witness {
        address to;
        uint256 validAfter;
    }
    function PERMIT2() external view returns (address);
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        address payer,
        Witness calldata witness,
        bytes calldata signature
    ) external;
}

interface IX402UptoProxy {
    struct Witness {
        address to;
        address facilitator;
        uint256 validAfter;
    }
    function PERMIT2() external view returns (address);
    function settle(
        ISignatureTransfer.PermitTransferFrom calldata permit,
        uint256 amount,
        address payer,
        Witness calldata witness,
        bytes calldata signature
    ) external;
}

/// @notice Payment-only Router target. Merchant EOA signs the exact Router intent. The account's
/// session separately authorizes Permit2; its reservation/approval must ALREADY exist.
/// No bootstrap, reservation, approval, arbitrary forwarding, custody or admin sponsorship selector.
contract X402FundedGateway is ISponsoredTarget, ReentrancyGuard {
    address public constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant EXACT = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address public constant UPTO = 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002;
    uint256 public constant MAX_WINDOW = 300;
    uint256 public constant MAX_CALLDATA = 452; // upto: selector + 10 head words + length word + 65-byte padded signature
    Router public immutable router;
    X402AccountFactory public immutable factory;
    uint256 public immutable maxAmount;
    uint32 public immutable maxAccountCalls;
    uint32 public immutable maxMerchantCalls;
    uint32 public immutable maxGlobalCalls;
    bytes32 private immutable runtimeCommitment;

    struct Limits {
        uint256 amount;
        uint32 accountCalls;
        uint32 merchantCalls;
        uint32 globalCalls;
    }

    struct Daily {
        uint64 day;
        uint32 calls;
    }
    mapping(address => Daily) public accountDaily;
    mapping(address => Daily) public merchantDaily;
    Daily public globalDaily;
    error InvalidConfig();
    error InvalidContext();
    error InvalidCall();
    error InvalidPayment();
    error UnapprovedAccount();
    error InvalidAuthorization();
    error PermitUsed();
    error DailyCap();
    error TransferMismatch();
    event PaymentSettled(
        bytes32 indexed permitDigest,
        address indexed payer,
        address indexed merchant,
        address proxy,
        uint256 nonce,
        uint256 ceiling,
        uint256 amount
    );

    constructor(Router router_, X402AccountFactory factory_, Limits memory limits) {
        if (
            block.chainid != 1874 || address(router_).code.length == 0
                || address(factory_).codehash != keccak256(type(X402AccountFactory).runtimeCode)
                || address(router_.usdt()) != USDT || router_.gasTank().router() != address(router_)
                || limits.amount == 0 || limits.amount > 100_000_000 || limits.accountCalls == 0
                || limits.merchantCalls == 0 || limits.globalCalls == 0 || USDT.code.length == 0
                || PERMIT2.code.length == 0 || EXACT.code.length == 0 || UPTO.code.length == 0
                || IX402ExactProxy(EXACT).PERMIT2() != PERMIT2 || IX402UptoProxy(UPTO).PERMIT2() != PERMIT2
        ) revert InvalidConfig();
        router = router_;
        factory = factory_;
        maxAmount = limits.amount;
        maxAccountCalls = limits.accountCalls;
        maxMerchantCalls = limits.merchantCalls;
        maxGlobalCalls = limits.globalCalls;
        // Deployment MUST independently attest official runtime hashes. There are no alternative
        // token/proxy constructor arguments. This commitment additionally refuses later code changes.
        runtimeCommitment = _runtimes();
    }

    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount) {
        if (data.length < 4 || data.length > MAX_CALLDATA) revert InvalidCall();
        bytes4 selector = bytes4(data[:4]);
        if (selector == this.settleExact.selector) {
            (
                ISignatureTransfer.PermitTransferFrom memory p,
                address payer,
                IX402ExactProxy.Witness memory w,
                bytes memory sig
            ) = abi.decode(data[4:], (ISignatureTransfer.PermitTransferFrom, address, IX402ExactProxy.Witness, bytes));
            _canonical(data, abi.encodeWithSelector(selector, p, payer, w, sig));
            _validate(p, payer, w.to, p.permitted.amount, EXACT, address(0), w.validAfter, sig);
            return (w.to, p.permitted.amount);
        }
        if (selector == this.settleUpto.selector) {
            (
                ISignatureTransfer.PermitTransferFrom memory p,
                uint256 actual,
                address payer,
                IX402UptoProxy.Witness memory w,
                bytes memory sig
            ) = abi.decode(
                data[4:], (ISignatureTransfer.PermitTransferFrom, uint256, address, IX402UptoProxy.Witness, bytes)
            );
            _canonical(data, abi.encodeWithSelector(selector, p, actual, payer, w, sig));
            _validate(p, payer, w.to, actual, UPTO, w.facilitator, w.validAfter, sig);
            return (w.to, actual);
        }
        revert InvalidCall();
    }

    function settleExact(
        ISignatureTransfer.PermitTransferFrom calldata p,
        address payer,
        IX402ExactProxy.Witness calldata w,
        bytes calldata sig
    ) external nonReentrant returns (bool) {
        _context(w.to);
        _canonical(msg.data, abi.encodeWithSelector(this.settleExact.selector, p, payer, w, sig));
        bytes32 digest = _validate(p, payer, w.to, p.permitted.amount, EXACT, address(0), w.validAfter, sig);
        _consume(payer, w.to);
        uint256 payerBefore = IERC20(USDT).balanceOf(payer);
        uint256 merchantBefore = IERC20(USDT).balanceOf(w.to);
        IX402ExactProxy(EXACT).settle(p, payer, w, sig);
        _transferred(payer, w.to, p.permitted.amount, payerBefore, merchantBefore);
        emit PaymentSettled(digest, payer, w.to, EXACT, p.nonce, p.permitted.amount, p.permitted.amount);
        return true;
    }

    function settleUpto(
        ISignatureTransfer.PermitTransferFrom calldata p,
        uint256 actual,
        address payer,
        IX402UptoProxy.Witness calldata w,
        bytes calldata sig
    ) external nonReentrant returns (bool) {
        _context(w.to);
        _canonical(msg.data, abi.encodeWithSelector(this.settleUpto.selector, p, actual, payer, w, sig));
        bytes32 digest = _validate(p, payer, w.to, actual, UPTO, w.facilitator, w.validAfter, sig);
        _consume(payer, w.to);
        uint256 payerBefore = IERC20(USDT).balanceOf(payer);
        uint256 merchantBefore = IERC20(USDT).balanceOf(w.to);
        IX402UptoProxy(UPTO).settle(p, actual, payer, w, sig);
        _transferred(payer, w.to, actual, payerBefore, merchantBefore);
        emit PaymentSettled(digest, payer, w.to, UPTO, p.nonce, p.permitted.amount, actual);
        return true;
    }

    function _context(address merchant) private view {
        if (
            msg.sender != address(router) || merchant == address(0) || router.activeSigner() != merchant
                || router.activeMerchant() != merchant
        ) revert InvalidContext();
    }

    function _canonical(bytes calldata supplied, bytes memory canonical) private pure {
        if (supplied.length > MAX_CALLDATA || keccak256(supplied) != keccak256(canonical)) revert InvalidCall();
    }

    function _runtimes() private view returns (bytes32) {
        return keccak256(abi.encode(USDT.codehash, PERMIT2.codehash, EXACT.codehash, UPTO.codehash));
    }

    function _validate(
        ISignatureTransfer.PermitTransferFrom memory p,
        address payer,
        address merchant,
        uint256 actual,
        address spender,
        address facilitator,
        uint256 validAfter,
        bytes memory sig
    ) private view returns (bytes32 digest) {
        if (
            block.chainid != 1874 || _runtimes() != runtimeCommitment || p.permitted.token != USDT
                || merchant == address(0) || merchant == payer || actual == 0 || actual > p.permitted.amount
                || p.permitted.amount > maxAmount || p.deadline < block.timestamp
                || p.deadline > block.timestamp + MAX_WINDOW || validAfter > block.timestamp || sig.length != 65
                || (spender == UPTO && facilitator != address(this))
        ) revert InvalidPayment();
        if (!factory.isAccount(payer)) revert UnapprovedAccount();
        _checkCount(accountDaily[payer], maxAccountCalls);
        _checkCount(merchantDaily[merchant], maxMerchantCalls);
        _checkCount(globalDaily, maxGlobalCalls);
        if (ISignatureTransfer(PERMIT2).nonceBitmap(payer, p.nonce >> 8) & (1 << (p.nonce & 255)) != 0) {
            revert PermitUsed();
        }
        X402AgentAccount account = X402AgentAccount(payer);
        digest = account.permitDigest(
            X402AgentAccount.Payment(
                spender, p.permitted.amount, p.nonce, p.deadline, merchant, facilitator, validAfter
            )
        );
        if (account.isValidSignature(digest, sig) != 0x1626ba7e) revert InvalidAuthorization();
    }

    function _checkCount(Daily memory d, uint32 limit) private view {
        if (d.day == block.timestamp / 1 days && d.calls >= limit) revert DailyCap();
    }

    function _increment(Daily storage d) private {
        uint64 day = uint64(block.timestamp / 1 days);
        if (d.day != day) {
            d.day = day;
            d.calls = 0;
        }
        ++d.calls;
    }

    function _consume(address payer, address merchant) private {
        _increment(accountDaily[payer]);
        _increment(merchantDaily[merchant]);
        _increment(globalDaily);
    }

    function _transferred(address payer, address merchant, uint256 amount, uint256 payerBefore, uint256 merchantBefore)
        private
        view
    {
        if (
            IERC20(USDT).balanceOf(payer) + amount != payerBefore
                || IERC20(USDT).balanceOf(merchant) != merchantBefore + amount
        ) revert TransferMismatch();
    }
}
