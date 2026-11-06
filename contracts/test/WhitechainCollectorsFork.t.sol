// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {Router} from "../src/Router.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {IERC3009} from "../src/interfaces/IERC3009.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {SuiteDeployment} from "../script/Deploy.s.sol";

/// @notice Opt-in fork test of the v3 one-signature collectors against Whitechain Sepolia's real USDT
/// (EIP-3009, EIP-2612) and canonical Permit2, at the latest block:
///   WHITECHAIN_RPC=https://rpc.ankr.com/whitechain_testnet forge test --match-contract WhitechainCollectorsFork -vv
/// The payer's USDT is written into the token's storage (`deal`), only inside the local fork.
contract WhitechainCollectorsForkTest is Test, SuiteDeployment {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    bytes32 constant PERMIT2_RUNTIME_HASH = 0xe781195c9a243da5bd6aebf363cb22381703b31978b5928f937fc64778afe303;
    bytes32 constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
    bytes32 constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    uint256 constant PAYER_KEY = 0xA11CE77;
    uint256 constant MERCHANT_KEY = 0xBEEF77;

    FeeSchedule fees;
    Router router;
    PaymentEscrow escrow;
    SubscriptionManagerV2 subscriptions;
    address payer = vm.addr(PAYER_KEY);
    address merchant = vm.addr(MERCHANT_KEY);
    address relayer = makeAddr("collectors-fork-relayer");
    bool forkEnabled;

    function setUp() public {
        string memory rpc = vm.envOr("WHITECHAIN_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 1874);
        assertEq(CANONICAL_PERMIT2.codehash, PERMIT2_RUNTIME_HASH, "Permit2 is not the canonical runtime");
        forkEnabled = true;
        (fees, router, escrow, subscriptions) =
            _deploySuite(IERC20(USDT), relayer, relayer, 79_000_000, CANONICAL_PERMIT2);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MERCHANT_KEY, fees.hashAcceptance(merchant, 1, 0, deadline));
        fees.acceptWithSig(merchant, 1, deadline, abi.encodePacked(r, s, v));
        deal(USDT, payer, 50_000_000);
        assertEq(IERC20(USDT).balanceOf(payer), 50_000_000);
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", IERC20Permit(USDT).DOMAIN_SEPARATOR(), structHash));
    }

    function testRealUsdtPaysWithOneReceiveWithAuthorization() public {
        vm.skip(!forkEnabled, "Set WHITECHAIN_RPC to run against Whitechain Sepolia");
        PaymentEscrow.Terms memory t = PaymentEscrow.Terms(keccak256("fork-3009"), payer, merchant, 10_000_000, 1 days, 0);
        bytes32 nonce = escrow.authorizationNonce(t);
        uint256 validBefore = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PAYER_KEY, _digest(keccak256(abi.encode(RECEIVE_TYPEHASH, payer, address(escrow), t.amount, 0, validBefore, nonce)))
        );
        uint256 merchantBefore = IERC20(USDT).balanceOf(merchant);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, validBefore, v, r, s);
        vm.snapshotGasLastCall("fork", "real_usdt_charge_with_authorization");
        assertEq(IERC20(USDT).balanceOf(payer), 40_000_000);
        assertEq(IERC20(USDT).balanceOf(merchant) - merchantBefore, 10_000_000 - 150_000);
        assertEq(IERC20(USDT).balanceOf(relayer), 150_000);
        assertEq(IERC20(USDT).balanceOf(address(escrow)), 0);
        assertTrue(IERC3009(USDT).authorizationState(payer, nonce));
        vm.expectRevert();
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, validBefore, v, r, s);
    }

    function testRealPermit2PaysWithTheFirstPermitBundled() public {
        vm.skip(!forkEnabled, "Set WHITECHAIN_RPC to run against Whitechain Sepolia");
        PaymentEscrow.Terms memory t = PaymentEscrow.Terms(keccak256("fork-permit2"), payer, merchant, 10_000_000, 1 days, 0);
        uint256 deadline = block.timestamp + 1 hours;
        uint256 permitNonce = IERC20Permit(USDT).nonces(payer);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(
            PAYER_KEY,
            _digest(keccak256(abi.encode(PERMIT_TYPEHASH, payer, CANONICAL_PERMIT2, type(uint256).max, permitNonce, deadline)))
        );
        bytes memory erc2612 = abi.encode(type(uint256).max, deadline, v, r, s);
        ISignatureTransfer.PermitTransferFrom memory permit =
            ISignatureTransfer.PermitTransferFrom(ISignatureTransfer.TokenPermissions(USDT, t.amount), 0, deadline);
        bytes32 typeHash = keccak256(
            abi.encodePacked(
                "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
                escrow.PERMIT2_WITNESS_TYPE()
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                typeHash,
                keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, USDT, t.amount)),
                address(escrow),
                uint256(0),
                deadline,
                escrow.hashTerms(t)
            )
        );
        (v, r, s) = vm.sign(
            PAYER_KEY,
            keccak256(abi.encodePacked("\x19\x01", ISignatureTransfer(CANONICAL_PERMIT2).DOMAIN_SEPARATOR(), structHash))
        );
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, abi.encodePacked(r, s, v), erc2612);
        vm.snapshotGasLastCall("fork", "real_usdt_charge_with_permit2_first_payment");
        assertEq(IERC20(USDT).balanceOf(payer), 40_000_000);
        // The real token spends even a maximum allowance down (no infinite-approval special case).
        assertEq(IERC20(USDT).allowance(payer, CANONICAL_PERMIT2), type(uint256).max - t.amount);
        assertEq(IERC20(USDT).balanceOf(relayer), 150_000);
    }
}
