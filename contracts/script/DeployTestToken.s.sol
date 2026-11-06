// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Script} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {Router} from "../src/Router.sol";
import {SuiteDeployment} from "./Deploy.s.sol";
import {MockNoBoolUSDT} from "../test/mocks/MockNoBoolUSDT.sol";

/// @notice Test-only deployment on Whitechain Sepolia using a self-issued 6-decimal token. Not the prize token.
contract DeployTestToken is Script, SuiteDeployment {
    error WrongChain();

    function run()
        external
        returns (
            MockNoBoolUSDT token,
            FeeSchedule fees,
            Router router,
            PaymentEscrow escrow,
            SubscriptionManagerV2 subscriptions
        )
    {
        if (block.chainid != 1874) revert WrongChain();
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address relayer = vm.envOr("RELAYER", deployer);
        address keeper = vm.envOr("KEEPER", relayer);
        uint256 usdtPerWBT = vm.envUint("USDT_PER_WBT");
        vm.startBroadcast(deployerKey);
        token = new MockNoBoolUSDT();
        (fees, router, escrow, subscriptions) = _deploySuite(IERC20(address(token)), relayer, keeper, usdtPerWBT);
        vm.stopBroadcast();
    }
}
