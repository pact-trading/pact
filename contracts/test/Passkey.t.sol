// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {Base64} from "@openzeppelin/contracts/utils/Base64.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {PasskeyAccount} from "../src/PasskeyAccount.sol";
import {PasskeyAccountFactory} from "../src/PasskeyAccountFactory.sol";
import {WebAuthn} from "../src/WebAuthn.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {PactSuite} from "./utils/PactSuite.sol";

/// @notice Passkey accounts: WebAuthn assertions over real P-256 signatures, ERC-1271 for Permit2,
/// signed call batches, and a one-signature checkout through the escrow's Permit2 collector.
contract PasskeyTest is PactSuite {
    uint256 constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 constant PASSKEY = 0x5eC1E7;
    uint256 constant OTHER_PASSKEY = 0xD1FFE7;
    bytes1 constant UP_UV = 0x05; // User Present | User Verified
    PasskeyAccountFactory factory;
    PasskeyAccount account;
    bytes32 x;
    bytes32 y;

    function setUp() public {
        vm.warp(10 days);
        _deploy();
        factory = new PasskeyAccountFactory(IERC20(address(token)), address(permit2));
        (uint256 px, uint256 py) = vm.publicKeyP256(PASSKEY);
        (x, y) = (bytes32(px), bytes32(py));
        account = factory.createAccount(x, y, 0);
        token.mint(address(account), 100_000_000);
    }

    /// @dev A WebAuthn assertion for `challenge` as a browser builds it: authenticator data for rpId
    /// pay.pactagent.app with `flags`, and clientDataJSON with `type` first and `challenge` second.
    function _assertion(uint256 key, bytes32 challenge, bytes1 flags, string memory type_)
        internal
        pure
        returns (WebAuthn.Auth memory auth)
    {
        auth.authenticatorData = abi.encodePacked(sha256("pay.pactagent.app"), flags, uint32(7));
        auth.clientDataJSON = string.concat(
            '{"type":"',
            type_,
            '","challenge":"',
            Base64.encodeURL(abi.encodePacked(challenge)),
            '","origin":"https://pay.pactagent.app","crossOrigin":false}'
        );
        auth.typeIndex = 1;
        // '{"type":"' (9) + type + '",' (2)
        auth.challengeIndex = 9 + bytes(type_).length + 2;
        bytes32 message = sha256(abi.encodePacked(auth.authenticatorData, sha256(bytes(auth.clientDataJSON))));
        (bytes32 r, bytes32 s) = vm.signP256(key, message);
        // Low-s normalization, as clients must do.
        if (uint256(s) > N / 2) s = bytes32(N - uint256(s));
        (auth.r, auth.s) = (r, s);
    }

    function _signature(bytes32 challenge) internal pure returns (bytes memory) {
        return abi.encode(_assertion(PASSKEY, challenge, UP_UV, "webauthn.get"));
    }

    function _valid(bytes32 hash, bytes memory signature) internal view returns (bool) {
        return account.isValidSignature(hash, signature) == IERC1271.isValidSignature.selector;
    }

    // ------------------------------------------------------------------ factory

    function testTheFactoryIsDeterministicIdempotentAndApprovesPermit2() public {
        assertEq(address(account), factory.accountAddress(x, y, 0));
        assertEq(address(factory.createAccount(x, y, 0)), address(account));
        assertTrue(factory.accountAddress(x, y, 1) != address(account));
        assertEq(account.x(), x);
        assertEq(account.y(), y);
        assertEq(token.allowance(address(account), address(permit2)), type(uint256).max);
        vm.expectRevert(PasskeyAccount.AlreadyInitialized.selector);
        account.initialize(x, y);
        PasskeyAccount implementation = factory.implementation();
        vm.expectRevert(PasskeyAccount.AlreadyInitialized.selector);
        vm.prank(address(factory));
        implementation.initialize(x, y);
    }

    function testAKeyOffTheCurveIsRefused() public {
        vm.expectRevert(PasskeyAccount.InvalidKey.selector);
        factory.createAccount(bytes32(uint256(1)), bytes32(uint256(2)), 0);
    }

    // ------------------------------------------------------------------ ERC-1271 and WebAuthn

    function testAValidPasskeyAssertionIsAValidSignature() public view {
        bytes32 hash = keccak256("message");
        assertTrue(_valid(hash, _signature(account.replaySafeHash(hash))));
    }

    function testEveryWebAuthnCheckIsEnforced() public view {
        bytes32 hash = keccak256("message");
        bytes32 challenge = account.replaySafeHash(hash);
        // Signed over the raw hash instead of the account's replay-safe hash.
        assertFalse(_valid(hash, _signature(hash)));
        // A registration ceremony, not an assertion.
        assertFalse(_valid(hash, abi.encode(_assertion(PASSKEY, challenge, UP_UV, "webauthn.create"))));
        // No user presence; presence without verification (the account requires UV).
        assertFalse(_valid(hash, abi.encode(_assertion(PASSKEY, challenge, 0x04, "webauthn.get"))));
        assertFalse(_valid(hash, abi.encode(_assertion(PASSKEY, challenge, 0x01, "webauthn.get"))));
        // Backed up (BS) without being backup eligible (BE).
        assertFalse(_valid(hash, abi.encode(_assertion(PASSKEY, challenge, 0x15, "webauthn.get"))));
        // Backed up and eligible is fine.
        assertTrue(_valid(hash, abi.encode(_assertion(PASSKEY, challenge, 0x1D, "webauthn.get"))));
        // Another passkey.
        assertFalse(_valid(hash, abi.encode(_assertion(OTHER_PASSKEY, challenge, UP_UV, "webauthn.get"))));
        // The malleable high-s twin of a valid signature.
        WebAuthn.Auth memory auth = _assertion(PASSKEY, challenge, UP_UV, "webauthn.get");
        auth.s = bytes32(N - uint256(auth.s));
        assertFalse(_valid(hash, abi.encode(auth)));
        // Indices that point elsewhere, or past the end.
        auth = _assertion(PASSKEY, challenge, UP_UV, "webauthn.get");
        auth.challengeIndex += 1;
        assertFalse(_valid(hash, abi.encode(auth)));
        auth.challengeIndex = type(uint256).max;
        assertFalse(_valid(hash, abi.encode(auth)));
        auth = _assertion(PASSKEY, challenge, UP_UV, "webauthn.get");
        auth.typeIndex = bytes(auth.clientDataJSON).length;
        assertFalse(_valid(hash, abi.encode(auth)));
        // Truncated authenticator data.
        auth = _assertion(PASSKEY, challenge, UP_UV, "webauthn.get");
        auth.authenticatorData = abi.encodePacked(bytes32(0), UP_UV);
        assertFalse(_valid(hash, abi.encode(auth)));
    }

    function testFuzzAnyOtherChallengeIsRefused(bytes32 hash, bytes32 signed) public view {
        vm.assume(hash != signed);
        assertFalse(_valid(hash, _signature(account.replaySafeHash(signed))));
    }

    function testOnePasskeysSignatureCannotBeReplayedOnItsOtherAccount() public {
        PasskeyAccount second = factory.createAccount(x, y, 1);
        bytes32 hash = keccak256("message");
        bytes memory signature = _signature(account.replaySafeHash(hash));
        assertTrue(_valid(hash, signature));
        assertEq(second.isValidSignature(hash, signature), bytes4(0xffffffff));
    }

    // ------------------------------------------------------------------ execute

    function _transferCall(address to, uint256 amount) internal view returns (PasskeyAccount.Call[] memory calls) {
        calls = new PasskeyAccount.Call[](1);
        calls[0] = PasskeyAccount.Call(address(token), 0, abi.encodeCall(token.transfer, (to, amount)));
    }

    function testAnyoneSubmitsAPasskeySignedBatchOnce() public {
        PasskeyAccount.Call[] memory calls = _transferCall(merchant, 5_000_000);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory signature = _signature(account.hashExecute(calls, 0, deadline));
        vm.prank(relayer);
        account.execute(calls, 0, deadline, signature);
        assertEq(token.balanceOf(merchant), 5_000_000);
        assertEq(account.nonce(), 1);
        vm.expectRevert(PasskeyAccount.InvalidNonce.selector);
        vm.prank(relayer);
        account.execute(calls, 0, deadline, signature);
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        vm.prank(relayer);
        account.execute(calls, 1, deadline, signature);
    }

    function testTamperedExpiredOrFailingBatchesDoNotRun() public {
        PasskeyAccount.Call[] memory calls = _transferCall(merchant, 5_000_000);
        uint256 deadline = block.timestamp + 5 minutes;
        bytes memory signature = _signature(account.hashExecute(calls, 0, deadline));
        PasskeyAccount.Call[] memory tampered = _transferCall(other, 5_000_000);
        vm.expectRevert(PasskeyAccount.InvalidSignature.selector);
        account.execute(tampered, 0, deadline, signature);
        vm.warp(deadline + 1);
        vm.expectRevert(PasskeyAccount.Expired.selector);
        account.execute(calls, 0, deadline, signature);
        vm.warp(10 days);
        // A call that fails reverts the whole batch and does not use the nonce.
        PasskeyAccount.Call[] memory failing = _transferCall(merchant, 500_000_000);
        bytes memory failingSignature = _signature(account.hashExecute(failing, 0, deadline));
        vm.expectRevert("balance");
        account.execute(failing, 0, deadline, failingSignature);
        assertEq(account.nonce(), 0);
        assertEq(token.balanceOf(merchant), 0);
    }

    // ------------------------------------------------------------------ one-signature checkout

    function testAPasskeyPaysThroughPermit2WithOneSignature() public {
        token.mint(merchant, 1); // the merchant's balance is non-zero, as in production
        PaymentEscrow.Terms memory t =
            PaymentEscrow.Terms(keccak256("passkey-payment"), address(account), merchant, 20_000_000, 1 days, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        bytes32 digest = _permit2Digest(permit, address(escrow), escrow.hashTerms(t));
        bytes memory signature = _signature(account.replaySafeHash(digest));
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, "");
        assertEq(token.balanceOf(address(account)), 80_000_000);
        assertEq(token.balanceOf(merchant), 1 + 20_000_000 - _checkoutFee(20_000_000));
        assertEq(escrow.payment(t.id).payer, address(account));
        // The same assertion cannot pay again.
        vm.expectRevert(PaymentEscrow.InvalidPayment.selector);
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, "");
    }
}
