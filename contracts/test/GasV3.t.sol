// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {Router} from "../src/Router.sol";
import {ISignatureTransfer} from "../src/interfaces/ISignatureTransfer.sol";
import {PactSuite} from "./utils/PactSuite.sol";

/// @notice Gas of each v3 payment path as its own transaction. Run with isolation so every call is a
/// separate transaction with cold state, as on chain:
///   forge test --match-contract GasV3 --isolate -vv
/// Merchant, payer and fee recipient already hold USDT, as they do in production.
contract GasV3Test is PactSuite {
    function setUp() public {
        vm.warp(10 days);
        _deploy();
        token.mint(payer, 1_000_000_000);
        token.mint(merchant, 1_000_000_000);
        token.mint(relayer, 1);
    }

    function _routerCharge(bytes32 id, uint256 nonce) internal {
        bytes memory data = abi.encodeCall(escrow.charge, (id, merchant, 10_000_000, uint64(1 days)));
        Router.Intent memory i = _intent(payer, address(escrow), data, 10_000_000, nonce);
        i.maxGas = 300_000;
        bytes memory signature = _sign(PAYER_KEY, router.hashIntent(i));
        vm.prank(relayer);
        router.execute(i, data, signature);
    }

    function testGasRouterCharge() public {
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        _routerCharge(keccak256("warm-up"), 0); // the payer's daily counter and nonce word exist
        _routerCharge(keccak256("first-in-word"), 256);
        vm.snapshotGasLastCall("v3", "router_charge_new_nonce_word");
        _routerCharge(keccak256("next-in-word"), 257);
        vm.snapshotGasLastCall("v3", "router_charge_same_nonce_word");
    }

    function testGasRouterRefund() public {
        vm.prank(payer);
        token.approve(address(escrow), type(uint256).max);
        vm.prank(payer);
        escrow.charge(keccak256("p"), merchant, 10_000_000, 1 days);
        vm.startPrank(merchant);
        token.approve(address(escrow), type(uint256).max);
        token.approve(address(router), type(uint256).max);
        vm.stopPrank();
        bytes memory warm = abi.encodeCall(escrow.refund, (keccak256("p"), 1_000_000, bytes32(0)));
        Router.Intent memory w = _intent(merchant, address(escrow), warm, 1_000_000, 0);
        _execute(w, warm);
        bytes memory data = abi.encodeCall(escrow.refund, (keccak256("p"), 5_000_000, bytes32(0)));
        Router.Intent memory i = _intent(merchant, address(escrow), data, 5_000_000, 1);
        i.maxGas = 300_000;
        bytes memory signature = _sign(MERCHANT_KEY, router.hashIntent(i));
        vm.prank(relayer);
        router.execute(i, data, signature);
        vm.snapshotGasLastCall("v3", "router_refund");
    }

    function testGasChargeWithAuthorization() public {
        PaymentEscrow.Terms memory t = _terms(keccak256("auth"), 10_000_000, 0);
        (uint8 v, bytes32 r, bytes32 s) = _authorization(PAYER_KEY, t, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        escrow.chargeWithAuthorization(t, 0, block.timestamp + 1 hours, v, r, s);
        vm.snapshotGasLastCall("v3", "charge_with_authorization");
    }

    function testGasChargeWithPermit2() public {
        vm.prank(payer);
        token.approve(address(permit2), type(uint256).max);
        PaymentEscrow.Terms memory t = _terms(keccak256("p2"), 10_000_000, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        bytes memory signature = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(t)));
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, "");
        vm.snapshotGasLastCall("v3", "charge_with_permit2_standing_approval");
    }

    function testGasChargeWithPermit2FirstPayment() public {
        PaymentEscrow.Terms memory t = _terms(keccak256("p2-first"), 10_000_000, 0);
        ISignatureTransfer.PermitTransferFrom memory permit = _permit2Transfer(t.amount, 0);
        bytes memory signature = _sign(PAYER_KEY, _permit2Digest(permit, address(escrow), escrow.hashTerms(t)));
        bytes memory erc2612 = _erc2612(PAYER_KEY, address(permit2), type(uint256).max);
        vm.prank(relayer);
        escrow.chargeWithPermit2(t, permit, signature, erc2612);
        vm.snapshotGasLastCall("v3", "charge_with_permit2_first_payment_bundled_permit");
    }

    function _mandate(uint256 nonce) internal view returns (SubscriptionManagerV2.Mandate memory) {
        return SubscriptionManagerV2.Mandate(
            payer, merchant, keccak256("monthly"), 2_000_000, 1 days, 12, uint64(block.timestamp + 30 days), nonce
        );
    }

    function _subscribe() internal returns (bytes32 id) {
        SubscriptionManagerV2.Mandate memory m = _mandate(subs.nonces(payer));
        bytes memory signature = _sign(PAYER_KEY, subs.hashMandate(m));
        vm.prank(relayer);
        id = subs.subscribe(m, signature);
    }

    function testGasSubscribeAndRenew() public {
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
        _subscribe(); // the payer's nonce exists
        bytes32 id = _subscribe();
        vm.snapshotGasLastCall("v3", "subscribe");
        vm.prank(keeper);
        subs.charge(id, 2_000_000);
        vm.snapshotGasLastCall("v3", "renewal_first_period");
        vm.warp(10 days + 1 days);
        vm.prank(keeper);
        subs.charge(id, 2_000_000);
        vm.snapshotGasLastCall("v3", "renewal_later_period");
    }

    function testGasChargeBatchOfTen() public {
        vm.prank(payer);
        token.approve(address(subs), type(uint256).max);
        bytes32[] memory ids = new bytes32[](10);
        uint256[] memory amounts = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            ids[i] = _subscribe();
            amounts[i] = 2_000_000;
        }
        vm.prank(keeper);
        subs.chargeBatch(ids, amounts); // first periods
        vm.warp(10 days + 1 days);
        vm.prank(keeper);
        subs.chargeBatch(ids, amounts);
        vm.snapshotGasLastCall("v3", "charge_batch_10_later_period");
    }
}
