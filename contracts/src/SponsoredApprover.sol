// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @title SponsoredApprover
/// @notice EIP-7702 delegate code. A payer's own address delegates to this contract so a relayer can pay the gas of the one-time
///         USDT approval. The payer only signs a message. Every call is bound to the payer address, chain, token, spender,
///         amount, nonce and deadline, so a relayer or anyone else cannot approve anything the payer did not sign.
/// @dev Storage lives in the payer's account when delegated. Only `approveFor` is exposed; there is no generic call.
contract SponsoredApprover {
    error InvalidSignature();
    error Expired();
    error TokenCallFailed();

    event ApprovalSponsored(address indexed payer, address indexed token, address indexed spender, uint256 amount, uint256 nonce);

    uint256 public approvalNonce;

    function approvalHash(address token, address spender, uint256 amount, uint256 nonce, uint256 deadline)
        public
        view
        returns (bytes32)
    {
        return MessageHashUtils.toEthSignedMessageHash(
            keccak256(abi.encode(block.chainid, address(this), token, spender, amount, nonce, deadline))
        );
    }

    function approveFor(address token, address spender, uint256 amount, uint256 deadline, bytes calldata signature) external {
        if (block.timestamp > deadline) revert Expired();
        uint256 nonce = approvalNonce++;
        if (ECDSA.recover(approvalHash(token, spender, amount, nonce, deadline), signature) != address(this)) {
            revert InvalidSignature();
        }
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0x095ea7b3, spender, amount));
        if (!ok || (data.length != 0 && (data.length != 32 || !abi.decode(data, (bool))))) revert TokenCallFailed();
        emit ApprovalSponsored(address(this), token, spender, amount, nonce);
    }
}
