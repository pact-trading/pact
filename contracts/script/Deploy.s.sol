// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSchedule, IFeeSchedule} from "../src/FeeSchedule.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {Router} from "../src/Router.sol";

/// @notice The payment suite and its Router allowlist, shared by the deploy scripts.
abstract contract SuiteDeployment {
    /// @notice Starting rates: checkout and renewals 0.8% (min 0.15 USDT); invoices 0.5% (min 0.15, cap 10 USDT).
    function _initialTerms() internal pure returns (FeeSchedule.Terms memory) {
        return FeeSchedule.Terms(FeeSchedule.Rate(80, 150_000, 0), FeeSchedule.Rate(50, 150_000, 10_000_000));
    }

    function _deploySuite(IERC20 usdt, address relayer, address keeper, uint256 usdtPerWBT)
        internal
        returns (FeeSchedule fees, Router router, PaymentEscrow escrow, SubscriptionManagerV2 subscriptions)
    {
        // The relayer receives every fee until a fee vault exists, and keeps the WBT price current.
        fees = new FeeSchedule(relayer, relayer, usdtPerWBT, _initialTerms());
        router = new Router(usdt, IFeeSchedule(address(fees)));
        escrow = new PaymentEscrow(usdt, address(router), IFeeSchedule(address(fees)));
        subscriptions = new SubscriptionManagerV2(usdt, address(router), keeper, IFeeSchedule(address(fees)));
        // (enabled, mustReturnTrue, chargesGas, checksAmount)
        router.setAllowed(address(escrow), escrow.authorize.selector, true, false, false, true);
        router.setAllowed(address(escrow), escrow.capture.selector, true, false, false, true);
        router.setAllowed(address(escrow), escrow.charge.selector, true, false, false, true);
        router.setAllowed(address(escrow), escrow.chargeInvoice.selector, true, false, false, true);
        router.setAllowed(address(escrow), escrow.void.selector, true, false, false, false);
        router.setAllowed(address(escrow), escrow.reclaim.selector, true, false, false, false);
        router.setAllowed(address(escrow), escrow.refund.selector, true, false, true, true);
        router.setAllowed(address(subscriptions), subscriptions.subscribe.selector, true, false, false, true);
        router.setAllowed(address(subscriptions), subscriptions.charge.selector, true, true, false, true);
        router.setAllowed(address(subscriptions), subscriptions.cancel.selector, true, false, false, false);
        router.setAllowed(address(subscriptions), subscriptions.replace.selector, true, false, false, true);
    }
}

/// @notice Whitechain Sepolia deployment and selector registration. No broadcast occurs without an explicit script run.
contract Deploy is Script, SuiteDeployment {
    address constant WHITECHAIN_USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    error WrongChain();

    function run()
        external
        returns (FeeSchedule fees, Router router, PaymentEscrow escrow, SubscriptionManagerV2 subscriptions)
    {
        if (block.chainid != 1874) revert WrongChain();
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address relayer = vm.envOr("RELAYER", deployer);
        address keeper = vm.envOr("KEEPER", relayer);
        uint256 usdtPerWBT = vm.envUint("USDT_PER_WBT");
        vm.startBroadcast(deployerKey);
        (fees, router, escrow, subscriptions) = _deploySuite(IERC20(WHITECHAIN_USDT), relayer, keeper, usdtPerWBT);
        vm.stopBroadcast();
    }
}
