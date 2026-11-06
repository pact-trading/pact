// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {WebAuthn} from "./WebAuthn.sol";

/// @notice A customer's USDT account owned by a passkey (a secp256r1 WebAuthn credential): Face ID,
/// Touch ID or a security key, no seed phrase. It never needs WBT: every action is a passkey
/// signature that anyone (Pact's relayer) submits.
/// - ERC-1271: `isValidSignature(hash, sig)` accepts a WebAuthn assertion whose challenge is
///   `replaySafeHash(hash)` (the hash wrapped in this account's EIP-712 domain, so one passkey's
///   signature for one account is never valid for another). Permit2 checks contract signers this way,
///   so the escrow's `chargeWithPermit2` takes a payment with one passkey signature.
/// - `execute(calls, nonce, deadline, sig)`: a batch of calls, signed as the EIP-712 `Execute` struct
///   (the challenge is its digest), with a sequential nonce.
/// - Initialization approves Permit2 to spend the account's USDT, so no approval transaction is ever needed.
/// @dev Deployed as ERC-1167 clones by `PasskeyAccountFactory`, which initializes each in the same
/// transaction. The account requires User Verification (biometrics or PIN) on every assertion.
contract PasskeyAccount is IERC1271, EIP712, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    error AlreadyInitialized();
    error InvalidKey();
    error InvalidNonce();
    error InvalidSignature();
    error Expired();

    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    bytes32 public constant CALL_TYPEHASH = keccak256("Call(address target,uint256 value,bytes data)");
    bytes32 public constant EXECUTE_TYPEHASH = keccak256(
        "Execute(Call[] calls,uint256 nonce,uint256 deadline)Call(address target,uint256 value,bytes data)"
    );
    bytes32 public constant MESSAGE_TYPEHASH = keccak256("PasskeyMessage(bytes32 hash)");
    bool public constant REQUIRES_USER_VERIFICATION = true;

    address public immutable factory;
    IERC20 public immutable usdt;
    address public immutable permit2;

    /// @notice The passkey's public key.
    bytes32 public x;
    bytes32 public y;
    /// @notice The next `execute` nonce.
    uint256 public nonce;

    event Initialized(bytes32 x, bytes32 y);
    event Executed(uint256 indexed nonce);

    constructor(IERC20 usdt_, address permit2_, address factory_) EIP712("Pact Passkey Account", "1") {
        usdt = usdt_;
        permit2 = permit2_;
        factory = factory_;
        // The implementation itself can never be initialized.
        x = bytes32(uint256(1));
    }

    function initialize(bytes32 x_, bytes32 y_) external {
        if (msg.sender != factory || x != 0 || y != 0) revert AlreadyInitialized();
        if (!P256.isValidPublicKey(x_, y_)) revert InvalidKey();
        x = x_;
        y = y_;
        if (permit2 != address(0)) usdt.forceApprove(permit2, type(uint256).max);
        emit Initialized(x_, y_);
    }

    /// @notice What the passkey signs for an ERC-1271 check of `hash`.
    function replaySafeHash(bytes32 hash) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(MESSAGE_TYPEHASH, hash)));
    }

    /// @notice `signature` is abi.encode(WebAuthn.Auth) for a challenge of `replaySafeHash(hash)`.
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        return _verify(replaySafeHash(hash), signature) ? IERC1271.isValidSignature.selector : bytes4(0xffffffff);
    }

    /// @notice The EIP-712 digest a passkey signs to run `calls` with `nonce_` before `deadline`.
    function hashExecute(Call[] calldata calls, uint256 nonce_, uint256 deadline) public view returns (bytes32) {
        bytes32[] memory hashes = new bytes32[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            hashes[i] = keccak256(abi.encode(CALL_TYPEHASH, calls[i].target, calls[i].value, keccak256(calls[i].data)));
        }
        return _hashTypedDataV4(
            keccak256(abi.encode(EXECUTE_TYPEHASH, keccak256(abi.encodePacked(hashes)), nonce_, deadline))
        );
    }

    /// @notice Run a passkey-signed batch of calls. Any call failing reverts the batch.
    function execute(Call[] calldata calls, uint256 nonce_, uint256 deadline, bytes calldata signature)
        external
        nonReentrant
        returns (bytes[] memory results)
    {
        if (block.timestamp > deadline) revert Expired();
        if (nonce_ != nonce) revert InvalidNonce();
        if (!_verify(hashExecute(calls, nonce_, deadline), signature)) revert InvalidSignature();
        nonce = nonce_ + 1;
        results = new bytes[](calls.length);
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            results[i] = ret;
        }
        emit Executed(nonce_);
    }

    receive() external payable {}

    function _verify(bytes32 digest, bytes calldata signature) internal view returns (bool) {
        WebAuthn.Auth memory auth = abi.decode(signature, (WebAuthn.Auth));
        return WebAuthn.verify(abi.encodePacked(digest), REQUIRES_USER_VERIFICATION, auth, x, y);
    }
}
