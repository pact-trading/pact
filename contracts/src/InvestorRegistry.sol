// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {Signatures} from "./Signatures.sol";

/// @notice Who may hold invoice receivable claims. A testnet stand-in for KYC: compliance officers
/// approve an investor address until an expiry, with an ISO 3166 region code, or revoke it.
/// Personal details stay off chain; only the address, its expiry and region are public. Officers may
/// sign a decision for anyone (Pact's relayer) to submit, so they need no gas.
contract InvestorRegistry is EIP712 {
    error NotOwner();
    error NotOfficer();
    error InvalidInvestor();
    error InvalidExpiry();
    error InvalidSignature();
    error SignatureExpired();

    struct Investor {
        bool approved;
        uint64 expiresAt;
        bytes2 region;
    }

    /// @notice An approval or revocation an officer signs (EIP-712 `Decision`). A revocation ignores
    /// `expiresAt` and `region`.
    struct Decision {
        address officer;
        address investor;
        bool approve;
        uint64 expiresAt;
        bytes2 region;
        uint256 deadline;
    }

    /// @notice Approvals may not run longer than this, so a forgotten approval lapses on its own.
    uint64 public constant MAX_APPROVAL = 400 days;
    bytes32 public constant DECISION_TYPEHASH = keccak256(
        "Decision(address officer,address investor,bool approve,uint64 expiresAt,bytes2 region,uint256 version,uint256 nonce,uint256 deadline)"
    );

    address public owner;
    address public pendingOwner;
    mapping(address => bool) public officers;
    mapping(address => Investor) public investors;
    /// @notice Signed decisions used, per officer.
    mapping(address => uint256) public nonces;
    /// @notice Decisions made about each investor so far. A signed decision names the count it was made
    /// against, so any later approval or revocation (by any officer) voids it: a pending approval cannot
    /// undo a revocation.
    mapping(address => uint256) public decisions;
    bytes32 public constant CANCEL_TYPEHASH = keccak256("Cancel(address signer,uint256 nonce,uint256 deadline)");

    event OwnershipTransferStarted(address indexed owner, address indexed pendingOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OfficerSet(address indexed officer, bool enabled);
    event InvestorApproved(address indexed investor, uint64 expiresAt, bytes2 region, address indexed officer);
    event InvestorRevoked(address indexed investor, address indexed officer);
    event NonceCancelled(address indexed signer, uint256 nonce);

    constructor(address owner_) EIP712("Pact Investor Registry", "1") {
        if (owner_ == address(0)) revert NotOwner();
        owner = owner_;
        officers[owner_] = true;
        emit OwnershipTransferred(address(0), owner_);
        emit OfficerSet(owner_, true);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @notice Start a two-step ownership transfer; the new owner must accept it.
    function transferOwnership(address next) external onlyOwner {
        pendingOwner = next;
        emit OwnershipTransferStarted(owner, next);
    }

    /// @notice The new owner takes over, including the previous owner's officer role: an ownership
    /// transfer (for example away from a compromised key) also ends that key's approvals.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner || msg.sender == address(0)) revert NotOwner();
        address previous = owner;
        emit OwnershipTransferred(previous, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
        officers[previous] = false;
        emit OfficerSet(previous, false);
        officers[msg.sender] = true;
        emit OfficerSet(msg.sender, true);
    }

    function setOfficer(address officer, bool enabled) external onlyOwner {
        if (officer == address(0)) revert NotOfficer();
        officers[officer] = enabled;
        emit OfficerSet(officer, enabled);
    }

    /// @notice Approve (or re-approve) an investor until `expiresAt`.
    function approve(address investor, uint64 expiresAt, bytes2 region) external {
        _approve(msg.sender, investor, expiresAt, region);
    }

    /// @notice Revoke an investor. Claims they already hold stay theirs and keep being paid,
    /// but they can no longer buy, send or receive claims.
    function revoke(address investor) external {
        _revoke(msg.sender, investor);
    }

    /// @notice A decision an officer signed, submitted by anyone.
    function decideWithSig(Decision calldata d, bytes calldata signature) external {
        if (block.timestamp > d.deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(
            keccak256(
                abi.encode(
                    DECISION_TYPEHASH, d.officer, d.investor, d.approve, d.expiresAt, d.region, decisions[d.investor], nonces[d.officer], d.deadline
                )
            )
        );
        if (!Signatures.isValid(d.officer, digest, signature)) revert InvalidSignature();
        nonces[d.officer]++;
        if (d.approve) _approve(d.officer, d.investor, d.expiresAt, d.region);
        else _revoke(d.officer, d.investor);
    }

    /// @notice Give up the current decision nonce: any decision signed with it can no longer run.
    function cancelNonce() external {
        emit NonceCancelled(msg.sender, nonces[msg.sender]++);
    }

    /// @notice The same, signed (EIP-712 `Cancel`) for a relayer to submit.
    function cancelNonceWithSig(address signer, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert SignatureExpired();
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(CANCEL_TYPEHASH, signer, nonces[signer], deadline)));
        if (!Signatures.isValid(signer, digest, signature)) revert InvalidSignature();
        emit NonceCancelled(signer, nonces[signer]++);
    }

    /// @notice Approved and not expired.
    function isApproved(address investor) external view returns (bool) {
        Investor memory i = investors[investor];
        return i.approved && i.expiresAt > block.timestamp;
    }

    function _approve(address officer, address investor, uint64 expiresAt, bytes2 region) internal {
        if (!officers[officer]) revert NotOfficer();
        if (investor == address(0) || region == bytes2(0)) revert InvalidInvestor();
        if (expiresAt <= block.timestamp || expiresAt > block.timestamp + MAX_APPROVAL) revert InvalidExpiry();
        investors[investor] = Investor(true, expiresAt, region);
        decisions[investor]++;
        emit InvestorApproved(investor, expiresAt, region, officer);
    }

    function _revoke(address officer, address investor) internal {
        if (!officers[officer]) revert NotOfficer();
        if (investor == address(0)) revert InvalidInvestor();
        investors[investor].approved = false;
        decisions[investor]++;
        emit InvestorRevoked(investor, officer);
    }
}
