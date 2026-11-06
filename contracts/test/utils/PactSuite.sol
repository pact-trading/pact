// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSchedule} from "../../src/FeeSchedule.sol";
import {PaymentEscrow} from "../../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../../src/SubscriptionManagerV2.sol";
import {Router} from "../../src/Router.sol";
import {ISignatureTransfer} from "../../src/interfaces/ISignatureTransfer.sol";
import {SuiteDeployment} from "../../script/Deploy.s.sol";
import {MockNoBoolUSDT} from "../mocks/MockNoBoolUSDT.sol";

/// @notice The deployed suite, wired exactly as the deploy script wires it, plus signing helpers.
abstract contract PactSuite is Test, SuiteDeployment {
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;
    /// @dev 79 USDT per WBT, the testnet pool price the API's dashboard estimate uses.
    uint256 constant USDT_PER_WBT = 79_000_000;
    uint256 constant PRICE = 1 gwei;
    /// @dev Whitechain's canonical Permit2 runtime, as pinned in docs/x402/whitechain-readonly.json.
    bytes32 constant PERMIT2_RUNTIME_HASH = 0xe781195c9a243da5bd6aebf363cb22381703b31978b5928f937fc64778afe303;
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    address payer;
    address merchant;
    /// Pact's relayer: it submits sponsored calls, receives every fee and keeps the WBT price.
    address relayer = address(0xCAFE);
    address keeper = address(0x4EE9);
    address other = address(0xBAD);
    MockNoBoolUSDT token;
    FeeSchedule fees;
    Router router;
    PaymentEscrow escrow;
    SubscriptionManagerV2 subs;
    ISignatureTransfer permit2 = ISignatureTransfer(CANONICAL_PERMIT2);

    function _deploy() internal {
        vm.txGasPrice(PRICE);
        payer = vm.addr(PAYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        token = new MockNoBoolUSDT();
        _etchPermit2();
        (fees, router, escrow, subs) =
            _deploySuite(IERC20(address(token)), relayer, keeper, USDT_PER_WBT, CANONICAL_PERMIT2);
        _acceptTerms(MERCHANT_KEY);
    }

    /// @dev The real Permit2 bytecode (fetched from Whitechain Sepolia), at its canonical address.
    function _etchPermit2() internal {
        bytes memory code = vm.parseBytes(vm.readFile("test/fixtures/permit2.runtime.hex"));
        assertEq(keccak256(code), PERMIT2_RUNTIME_HASH, "Permit2 fixture is not the canonical runtime");
        vm.etch(CANONICAL_PERMIT2, code);
    }

    function _sign(uint256 key, bytes32 digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _acceptTerms(uint256 key) internal {
        address account = vm.addr(key);
        uint32 version = fees.latestVersion();
        uint256 deadline = block.timestamp + 1 hours;
        bytes memory signature = _sign(key, fees.hashAcceptance(account, version, fees.nonces(account), deadline));
        vm.prank(relayer);
        fees.acceptWithSig(account, version, deadline, signature);
    }

    /// @dev The checkout rate the deploy script starts with: 0.8%, rounded up, at least 0.15 USDT.
    function _checkoutFee(uint256 amount) internal pure returns (uint256 fee) {
        fee = (amount * 80 + 9_999) / 10_000;
        if (fee < 150_000) fee = 150_000;
    }

    /// @dev The invoice rate: 0.5%, rounded up, at least 0.15 USDT, at most 10 USDT.
    function _invoiceFee(uint256 amount) internal pure returns (uint256 fee) {
        fee = (amount * 50 + 9_999) / 10_000;
        if (fee < 150_000) fee = 150_000;
        if (fee > 10_000_000) fee = 10_000_000;
    }

    function _intent(address signer, address target, bytes memory data, uint256 amount, uint256 nonce)
        internal
        view
        returns (Router.Intent memory)
    {
        return Router.Intent(
            signer, merchant, target, keccak256(data), amount, nonce, uint64(block.timestamp + 1 hours), 500_000
        );
    }

    function _keyFor(address signer) internal view returns (uint256) {
        if (signer == merchant) return MERCHANT_KEY;
        if (signer == payer) return PAYER_KEY;
        revert("unknown signer");
    }

    /// @dev Submit as Pact's relayer.
    function _execute(Router.Intent memory i, bytes memory data) internal returns (bool ok) {
        bytes memory signature = _sign(_keyFor(i.signer), router.hashIntent(i));
        vm.prank(relayer);
        (ok,) = router.execute(i, data, signature);
    }

    function _expectRefusal(Router.Intent memory i, Router.Refusal reason) internal {
        vm.expectEmit(true, true, true, true, address(router));
        emit Router.Refused(i.signer, i.merchant, i.nonce, reason);
    }

    // ------------------------------------------------------------------ one-signature collectors

    function _terms(bytes32 id, uint256 amount, uint8 product) internal view returns (PaymentEscrow.Terms memory) {
        return PaymentEscrow.Terms(id, payer, merchant, amount, 1 days, product);
    }

    /// @dev The payer's EIP-3009 ReceiveWithAuthorization for `t`, to the escrow.
    function _authorization(uint256 key, PaymentEscrow.Terms memory t, uint256 validAfter, uint256 validBefore)
        internal
        view
        returns (uint8 v, bytes32 r, bytes32 s)
    {
        bytes32 structHash = keccak256(
            abi.encode(
                token.RECEIVE_WITH_AUTHORIZATION_TYPEHASH(),
                t.payer,
                address(escrow),
                t.amount,
                validAfter,
                validBefore,
                escrow.authorizationNonce(t)
            )
        );
        (v, r, s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
    }

    function _permit2Transfer(uint256 amount, uint256 nonce)
        internal
        view
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(address(token), amount), nonce, block.timestamp + 1 hours
        );
    }

    /// @dev The Permit2 PermitWitnessTransferFrom digest whose witness is `witness` and spender `spender`.
    function _permit2Digest(ISignatureTransfer.PermitTransferFrom memory permit, address spender, bytes32 witness)
        internal
        view
        returns (bytes32)
    {
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                escrow.PERMIT2_WITNESS_TYPE()
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount)),
                spender,
                permit.nonce,
                permit.deadline,
                witness
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", permit2.DOMAIN_SEPARATOR(), structHash));
    }

    /// @dev The payer's EIP-2612 USDT permit, as `chargeWithPermit2` takes it.
    function _erc2612(uint256 key, address spender, uint256 value) internal view returns (bytes memory) {
        address owner = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(token.PERMIT_TYPEHASH(), owner, spender, value, token.nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));
        return abi.encode(value, deadline, v, r, s);
    }
}
