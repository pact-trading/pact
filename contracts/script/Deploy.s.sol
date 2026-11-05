// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";
import {GasTank} from "../src/GasTank.sol";
import {Router} from "../src/Router.sol";

/// @notice Whitechain Sepolia deployment and selector registration. No broadcast occurs without an explicit script run.
contract Deploy is Script {
    address constant WHITECHAIN_USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    error WrongChain();

    function run()
        external
        returns (GasTank tank, Router router, PaymentEscrow escrow, SubscriptionManager subscriptions)
    {
        if (block.chainid != 1874) revert WrongChain();
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address feeVault = vm.envOr("FEE_VAULT", deployer);
        address keeper = vm.envOr("KEEPER", deployer);
        vm.startBroadcast(deployerKey);
        tank = new GasTank();
        router = new Router(IERC20(WHITECHAIN_USDT), tank, feeVault);
        tank.setRouter(address(router));
        escrow = new PaymentEscrow(IERC20(WHITECHAIN_USDT), address(router));
        subscriptions = new SubscriptionManager(IERC20(WHITECHAIN_USDT), address(router), keeper);
        router.setAllowed(address(escrow), escrow.authorize.selector, true, false);
        router.setAllowed(address(escrow), escrow.capture.selector, true, false);
        router.setAllowed(address(escrow), escrow.charge.selector, true, false);
        router.setAllowed(address(escrow), escrow.void.selector, true, false);
        router.setAllowed(address(escrow), escrow.reclaim.selector, true, false);
        router.setAllowed(address(escrow), escrow.refund.selector, true, false);
        router.setAllowed(address(subscriptions), subscriptions.subscribe.selector, true, false);
        router.setAllowed(address(subscriptions), subscriptions.charge.selector, true, true);
        router.setAllowed(address(subscriptions), subscriptions.cancel.selector, true, false);
        router.setAllowed(address(subscriptions), subscriptions.replace.selector, true, false);
        vm.stopBroadcast();
    }
}
