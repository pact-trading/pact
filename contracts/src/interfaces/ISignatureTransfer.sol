// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice The part of Uniswap's canonical Permit2 (MIT, github.com/Uniswap/permit2) this suite uses:
/// signature transfers with a witness. Permit2 lives at 0x000000000022D473030F116dDEE9F6B43aC78BA3 on
/// Whitechain, with its canonical runtime.
interface ISignatureTransfer {
    struct TokenPermissions {
        address token;
        uint256 amount;
    }

    struct PermitTransferFrom {
        TokenPermissions permitted;
        uint256 nonce;
        uint256 deadline;
    }

    struct SignatureTransferDetails {
        address to;
        uint256 requestedAmount;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32);

    function nonceBitmap(address owner, uint256 wordPos) external view returns (uint256);

    /// @dev The witness type string follows EIP-712 ordering of nested structs and must include the
    /// TokenPermissions definition. The signed type is
    /// `PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,<witnessTypeString>`.
    function permitWitnessTransferFrom(
        PermitTransferFrom calldata permit,
        SignatureTransferDetails calldata transferDetails,
        address owner,
        bytes32 witness,
        string calldata witnessTypeString,
        bytes calldata signature
    ) external;
}
