// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @notice Minimal isolated x402 account. Reservations consume full authorized ceilings, even
/// if never settled. This prevents concurrent authorizations bypassing daily caps in static ERC-1271.
/// No arbitrary execution or token approval. Owner actions (bootstrap, session changes) can also be
/// signed by the owner and relayed, so an owner who holds no WBT never pays gas.
contract X402AgentAccount is EIP712 {
    using SafeERC20 for IERC20;
    address public constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address public constant EXACT = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address public constant UPTO = 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002;
    uint256 public constant MAX_APPROVAL = 100_000_000; // 100 USDT, never unlimited.
    bytes32 constant TOKEN_TYPE = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 constant EXACT_TYPE = keccak256("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)");
    bytes32 constant UPTO_TYPE = keccak256("PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)TokenPermissions(address token,uint256 amount)Witness(address to,address facilitator,uint256 validAfter)");
    bytes32 constant EXACT_WITNESS = keccak256("Witness(address to,uint256 validAfter)");
    bytes32 constant UPTO_WITNESS = keccak256("Witness(address to,address facilitator,uint256 validAfter)");
    bytes32 constant RESERVE_TYPE = keccak256("Reservation(bytes32 permitDigest,uint256 epoch)");
    bytes32 constant APPROVE_TYPE = keccak256("Bootstrap(uint256 amount,uint256 nonce,uint256 deadline)");
    bytes32 constant SESSION_TYPE = keccak256(
        "Session(address key,uint256 perCall,uint256 daily,uint256 expiry,address[] merchants,uint256 nonce,uint256 deadline)"
    );
    bytes32 constant REVOKE_TYPE = keccak256("Revoke(uint256 nonce,uint256 deadline)");

    address public immutable owner;
    address public sessionKey;
    uint256 public epoch;
    uint256 public perCallCap;
    uint256 public dailyCap;
    uint256 public expiresAt;
    uint256 public approvalNonce;
    mapping(address => uint256) public merchantEpoch;
    mapping(uint256 => uint256) public reservedPerDay;
    struct Reservation { uint256 epoch; uint256 deadline; bytes32 signatureHash; }
    mapping(bytes32 => Reservation) public reservations;
    struct Payment {
        address spender;
        uint256 amount;
        uint256 nonce;
        uint256 deadline;
        address to;
        address facilitator;
        uint256 validAfter;
    }
    error Unauthorized();
    error InvalidPolicy();
    error SessionExpired();
    error MerchantDenied();
    error PerCallCap();
    error DailyCap();
    error InvalidWindow();
    error AlreadyReserved();
    event SessionChanged(uint256 indexed epoch, address indexed key, uint256 perCallCap, uint256 dailyCap, uint256 expiresAt);
    event Reserved(bytes32 indexed digest, address indexed merchant, uint256 ceiling, uint256 day);
    event Bootstrapped(uint256 amount, uint256 nonce);

    constructor(address owner_) EIP712("Settle X402 Account", "1") {
        if (owner_ == address(0)) revert Unauthorized();
        owner = owner_;
    }
    modifier onlyOwner() { if (msg.sender != owner) revert Unauthorized(); _; }

    function configureSession(address key, uint256 perCall, uint256 daily, uint256 expiry, address[] calldata merchants) external onlyOwner {
        _configure(key, perCall, daily, expiry, merchants);
    }
    function revokeSession() external onlyOwner {
        _revoke();
    }

    /// @notice Owner-signed session change, relayed by anyone. Ten-minute signature lifetime and the
    /// shared owner nonce, so each signature works once and only for these exact limits.
    function configureSessionWithSig(
        address key,
        uint256 perCall,
        uint256 daily,
        uint256 expiry,
        address[] calldata merchants,
        uint256 deadline,
        bytes calldata signature
    ) external {
        if (deadline < block.timestamp || deadline > block.timestamp + 10 minutes) revert InvalidWindow();
        uint256 nonce = approvalNonce++;
        if (ECDSA.recover(sessionChangeDigest(key, perCall, daily, expiry, merchants, nonce, deadline), signature) != owner) revert Unauthorized();
        _configure(key, perCall, daily, expiry, merchants);
    }
    /// @notice Owner-signed revocation, relayed by anyone. Invalidates already-reserved authorizations.
    function revokeSessionWithSig(uint256 deadline, bytes calldata signature) external {
        if (deadline < block.timestamp || deadline > block.timestamp + 10 minutes) revert InvalidWindow();
        uint256 nonce = approvalNonce++;
        if (ECDSA.recover(revokeDigest(nonce, deadline), signature) != owner) revert Unauthorized();
        _revoke();
    }
    function sessionChangeDigest(
        address key,
        uint256 perCall,
        uint256 daily,
        uint256 expiry,
        address[] calldata merchants,
        uint256 nonce,
        uint256 deadline
    ) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(SESSION_TYPE, key, perCall, daily, expiry, keccak256(abi.encodePacked(merchants)), nonce, deadline))
        );
    }
    function revokeDigest(uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REVOKE_TYPE, nonce, deadline)));
    }

    function _configure(address key, uint256 perCall, uint256 daily, uint256 expiry, address[] calldata merchants) internal {
        if (key == address(0) || perCall == 0 || daily < perCall || expiry <= block.timestamp || merchants.length == 0 || merchants.length > 32) revert InvalidPolicy();
        ++epoch;
        sessionKey = key;
        perCallCap = perCall;
        dailyCap = daily;
        expiresAt = expiry;
        for (uint256 i; i < merchants.length; ++i) {
            if (merchants[i] == address(0)) revert InvalidPolicy();
            merchantEpoch[merchants[i]] = epoch;
        }
        emit SessionChanged(epoch, key, perCall, daily, expiry);
    }
    function _revoke() internal {
        ++epoch;
        sessionKey = address(0);
        emit SessionChanged(epoch, address(0), 0, 0, 0);
    }

    /// @notice Owner-signed gasless bootstrap, callable by a journal-managed relayer. Fixed token,
    /// spender, bounded amount, ten-minute signature lifetime and monotonic nonce. Zero revokes.
    /// M7 sponsorship/reimbursement is an integration requirement, not implemented by this account.
    function bootstrap(uint256 amount, uint256 deadline, bytes calldata signature) external {
        if (amount > MAX_APPROVAL || deadline < block.timestamp || deadline > block.timestamp + 10 minutes) revert InvalidWindow();
        uint256 nonce = approvalNonce++;
        if (ECDSA.recover(bootstrapDigest(amount, nonce, deadline), signature) != owner) revert Unauthorized();
        IERC20(USDT).forceApprove(PERMIT2, amount);
        emit Bootstrapped(amount, nonce);
    }
    function bootstrapDigest(uint256 amount, uint256 nonce, uint256 deadline) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(APPROVE_TYPE, amount, nonce, deadline)));
    }
    function sessionDigest(bytes32 digest) public view returns (bytes32) {
        // Bind the session signature to this account and epoch; Permit2's own digest omits owner.
        return _hashTypedDataV4(keccak256(abi.encode(RESERVE_TYPE, digest, epoch)));
    }
    function permitDigest(Payment calldata p) public view returns (bytes32) {
        bool exact = p.spender == EXACT;
        if (!exact && p.spender != UPTO) revert InvalidPolicy();
        if ((exact && p.facilitator != address(0)) || (!exact && p.facilitator == address(0))) revert InvalidPolicy();
        bytes32 witness = exact
            ? keccak256(abi.encode(EXACT_WITNESS, p.to, p.validAfter))
            : keccak256(abi.encode(UPTO_WITNESS, p.to, p.facilitator, p.validAfter));
        bytes32 structHash = keccak256(abi.encode(exact ? EXACT_TYPE : UPTO_TYPE,
            keccak256(abi.encode(TOKEN_TYPE, USDT, p.amount)), p.spender, p.nonce, p.deadline, witness));
        bytes32 domain = keccak256(abi.encode(
            keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)"),
            keccak256("Permit2"), block.chainid, PERMIT2));
        return keccak256(abi.encodePacked(hex"1901", domain, structHash));
    }
    function reserve(Payment calldata p, bytes calldata signature) external returns (bytes32 digest) {
        if (sessionKey == address(0) || block.timestamp >= expiresAt) revert SessionExpired();
        if (merchantEpoch[p.to] != epoch) revert MerchantDenied();
        if (p.amount == 0 || p.amount > perCallCap) revert PerCallCap();
        uint256 day = block.timestamp / 1 days;
        if (p.deadline < block.timestamp || p.deadline >= (day + 1) * 1 days || p.deadline > expiresAt || p.validAfter > block.timestamp) revert InvalidWindow();
        digest = permitDigest(p);
        if (reservations[digest].epoch != 0) revert AlreadyReserved();
        if (ECDSA.recover(sessionDigest(digest), signature) != sessionKey) revert Unauthorized();
        if (reservedPerDay[day] + p.amount > dailyCap) revert DailyCap();
        reservedPerDay[day] += p.amount;
        reservations[digest] = Reservation(epoch, p.deadline, keccak256(signature));
        emit Reserved(digest, p.to, p.amount, day);
    }
    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        Reservation memory r = reservations[digest];
        return sessionKey != address(0) && r.epoch == epoch && r.deadline >= block.timestamp
            && block.timestamp < expiresAt && r.signatureHash == keccak256(signature)
            ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }
    /// @notice Owner can recover funds without granting arbitrary execution to the agent.
    function withdraw(address to, uint256 amount) external onlyOwner {
        IERC20(USDT).safeTransfer(to, amount);
    }
}
