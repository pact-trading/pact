// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice EIP-3009 `receiveWithAuthorization`, the (v, r, s) form. Only the payee (`to`) may submit
/// it, so a signed authorization cannot be front-run into a plain transfer. Whitechain Sepolia's USDT
/// (0xcedf…55a7, EIP-712 domain "Tether USD" version "1") implements it; mainnet USDT does not, so the
/// escrow's Permit2 collector covers that token.
interface IERC3009 {
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external;

    function authorizationState(address authorizer, bytes32 nonce) external view returns (bool);
}
