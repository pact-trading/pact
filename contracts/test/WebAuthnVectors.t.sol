// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {WebAuthn} from "../src/WebAuthn.sol";
import {WebAuthnHarness} from "./harness/WebAuthnHarness.sol";

/// @notice WebAuthn verification through the harness, and the calldata used to check the same
/// vectors against Whitechain's RIP-7212 precompile (`-vv` prints them).
contract WebAuthnVectorsTest is Test {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant KEY = 0x5eC1E7;
    WebAuthnHarness harness = new WebAuthnHarness();

    function _vector(bool highS, uint256 signer) internal view returns (bytes memory call) {
        bytes memory challenge = abi.encodePacked(keccak256("whitechain-vector"));
        WebAuthn.Auth memory auth;
        auth.authenticatorData = abi.encodePacked(sha256("pay.pactagent.app"), bytes1(0x05), uint32(1));
        auth.clientDataJSON = string.concat(
            '{"type":"webauthn.get","challenge":"',
            Base64.encodeURL(challenge),
            '","origin":"https://pay.pactagent.app","crossOrigin":false}'
        );
        auth.typeIndex = 1;
        auth.challengeIndex = 23;
        (auth.r, auth.s) = vm.signP256(
            signer, sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))))
        );
        if (uint256(auth.s) > N / 2) auth.s = bytes32(N - uint256(auth.s));
        if (highS) auth.s = bytes32(N - uint256(auth.s));
        (uint256 x, uint256 y) = vm.publicKeyP256(KEY);
        call = abi.encodeCall(harness.verify, (challenge, true, auth, bytes32(x), bytes32(y)));
    }

    function testVectors() public {
        bytes memory valid = _vector(false, KEY);
        bytes memory highS = _vector(true, KEY);
        bytes memory wrongKey = _vector(false, KEY + 1);
        (, bytes memory a) = address(harness).staticcall(valid);
        (, bytes memory b) = address(harness).staticcall(highS);
        (, bytes memory c) = address(harness).staticcall(wrongKey);
        assertTrue(abi.decode(a, (bool)));
        assertFalse(abi.decode(b, (bool)));
        assertFalse(abi.decode(c, (bool)));
        emit log_named_bytes("valid", valid);
        emit log_named_bytes("high_s", highS);
        emit log_named_bytes("wrong_key", wrongKey);
    }
}
