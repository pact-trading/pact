// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {P256} from "@openzeppelin/contracts/utils/cryptography/P256.sol";

/// @notice Verifies a WebAuthn (passkey) assertion over a challenge, following the W3C WebAuthn
/// Level 2 assertion checks that apply on chain (the relying party's origin and rpId are the wallet
/// front end's concern):
/// - `clientDataJSON` contains `"type":"webauthn.get"` at `typeIndex`;
/// - it contains `"challenge":"<base64url(challenge), no padding>"` at `challengeIndex`;
/// - the authenticator data's User Present flag is set, and User Verified when required;
/// - a credential not eligible for backup does not claim to be backed up;
/// - (r, s) is a valid secp256r1 signature by (x, y) over sha256(authenticatorData || sha256(clientDataJSON)).
/// @dev P-256 checks use the RIP-7212 precompile at 0x100 (Whitechain has it) with OpenZeppelin's
/// Solidity fallback. A high `s` (above n/2) is rejected to prevent malleability: authenticators may
/// produce one, so clients must normalize it to `n - s` before submitting. On Whitechain the precompile
/// returns empty data for a bad signature, which makes OpenZeppelin fall back to the Solidity verifier:
/// a bad signature is still refused, at the fallback's higher gas cost.
library WebAuthn {
    struct Auth {
        bytes authenticatorData;
        string clientDataJSON;
        uint256 challengeIndex;
        uint256 typeIndex;
        bytes32 r;
        bytes32 s;
    }

    bytes1 private constant FLAG_USER_PRESENT = 0x01;
    bytes1 private constant FLAG_USER_VERIFIED = 0x04;
    bytes1 private constant FLAG_BACKUP_ELIGIBLE = 0x08;
    bytes1 private constant FLAG_BACKUP_STATE = 0x10;
    /// @dev keccak256('"type":"webauthn.get"'), 21 bytes.
    bytes32 private constant TYPE_GET_HASH = keccak256('"type":"webauthn.get"');
    uint256 private constant TYPE_GET_LENGTH = 21;

    function verify(bytes memory challenge, bool requireUserVerification, Auth memory auth, bytes32 x, bytes32 y)
        internal
        view
        returns (bool)
    {
        bytes memory authData = auth.authenticatorData;
        // rpIdHash (32) | flags (1) | signCount (4)
        if (authData.length < 37) return false;
        bytes1 flags = authData[32];
        if (flags & FLAG_USER_PRESENT == 0) return false;
        if (requireUserVerification && flags & FLAG_USER_VERIFIED == 0) return false;
        if (flags & FLAG_BACKUP_ELIGIBLE == 0 && flags & FLAG_BACKUP_STATE != 0) return false;

        bytes memory json = bytes(auth.clientDataJSON);
        if (_hashAt(json, auth.typeIndex, TYPE_GET_LENGTH) != TYPE_GET_HASH) return false;
        bytes memory expected = abi.encodePacked('"challenge":"', Base64.encodeURL(challenge), '"');
        if (_hashAt(json, auth.challengeIndex, expected.length) != keccak256(expected)) return false;

        bytes32 message = sha256(abi.encodePacked(authData, sha256(json)));
        return P256.verify(message, auth.r, auth.s, x, y);
    }

    /// @dev keccak256 of `data[index:index+length]`, or zero when that range is out of bounds.
    function _hashAt(bytes memory data, uint256 index, uint256 length) private pure returns (bytes32 h) {
        if (index > data.length || data.length - index < length) return bytes32(0);
        assembly ("memory-safe") {
            h := keccak256(add(add(data, 0x20), index), length)
        }
    }
}
