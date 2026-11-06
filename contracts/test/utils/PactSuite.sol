// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSchedule} from "../../src/FeeSchedule.sol";
import {PaymentEscrow} from "../../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../../src/SubscriptionManagerV2.sol";
import {Router} from "../../src/Router.sol";
import {SuiteDeployment} from "../../script/Deploy.s.sol";
import {MockNoBoolUSDT} from "../mocks/MockNoBoolUSDT.sol";

/// @notice The deployed suite, wired exactly as the deploy script wires it, plus signing helpers.
abstract contract PactSuite is Test, SuiteDeployment {
    uint256 constant PAYER_KEY = 0xA11CE;
    uint256 constant MERCHANT_KEY = 0xBEEF;
    /// @dev 79 USDT per WBT, the testnet pool price the API's dashboard estimate uses.
    uint256 constant USDT_PER_WBT = 79_000_000;
    uint256 constant PRICE = 1 gwei;
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

    function _deploy() internal {
        vm.txGasPrice(PRICE);
        payer = vm.addr(PAYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        token = new MockNoBoolUSDT();
        (fees, router, escrow, subs) = _deploySuite(IERC20(address(token)), relayer, keeper, USDT_PER_WBT);
        _acceptTerms(MERCHANT_KEY);
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
}
