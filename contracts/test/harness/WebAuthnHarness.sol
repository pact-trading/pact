// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {WebAuthn} from "../../src/WebAuthn.sol";

/// @notice Exposes the WebAuthn library, so its RIP-7212 precompile path can be checked on Whitechain
/// itself (eth_call with this runtime as a code override); forge's EVM has no P-256 precompile.
contract WebAuthnHarness {
    function verify(bytes memory challenge, bool requireUV, WebAuthn.Auth memory auth, bytes32 x, bytes32 y)
        external
        view
        returns (bool)
    {
        return WebAuthn.verify(challenge, requireUV, auth, x, y);
    }
}
