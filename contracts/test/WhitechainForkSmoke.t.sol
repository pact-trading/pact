// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Router} from "../src/Router.sol";
import {GasTank} from "../src/GasTank.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManager} from "../src/SubscriptionManager.sol";

/// @notice Opt-in, local EVM fork only: FORK_RPC=<archive RPC> forge test --match-contract WhitechainForkSmokeTest -vv
/// No broadcasts, real signing keys, token mocks, minting or token-storage overrides.
contract WhitechainForkSmokeTest is Test {
    using SafeERC20 for IERC20;

    uint256 constant FORK_BLOCK = 11_924_802;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address constant FUNDER = 0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a;
    // Public synthetic test keys, never loaded from the environment or used outside this fork.
    uint256 constant PAYER_KEY = 0xA11CE55;
    uint256 constant MERCHANT_KEY = 0xBEEF55;
    uint32 constant TARGET_GAS = 400_000;
    uint256 constant PRICE = 5_001_000_000;
    uint256 constant FEE = 10_000; // 0.01 USDT per successful execution.
    uint256 constant TANK_FUNDING = 0.1 ether;
    bytes32 constant PAYMENT_ID = keccak256("pinned-whitechain-fork-smoke");

    IERC20 token;
    GasTank tank;
    Router router;
    PaymentEscrow escrow;
    SubscriptionManager subscriptions;
    address payer;
    address merchant;
    address relayer;
    address vault;
    bool forkEnabled;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC", string(""));
        if (bytes(rpc).length == 0) return;
        vm.createSelectFork(rpc, FORK_BLOCK);
        // Impersonation is reachable only after the pinned fork is selected and checked.
        assertEq(block.chainid, 1874);
        assertEq(block.number, FORK_BLOCK);
        assertGt(USDT.code.length, 0);
        assertEq(IERC20Metadata(USDT).decimals(), 6);
        forkEnabled = true;
        vm.txGasPrice(PRICE);

        payer = vm.addr(PAYER_KEY);
        merchant = vm.addr(MERCHANT_KEY);
        relayer = makeAddr("whitechain-fork-relayer");
        vault = makeAddr("whitechain-fork-fee-vault");
        token = IERC20(USDT);

        // Same four-contract wiring and ten allowlist entries as Deploy.s.sol.
        tank = new GasTank();
        router = new Router(token, tank, vault);
        tank.setRouter(address(router));
        escrow = new PaymentEscrow(token, address(router));
        subscriptions = new SubscriptionManager(token, address(router), relayer);
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

        assertEq(token.balanceOf(FUNDER), 3_500_000);
        assertEq(token.balanceOf(payer), 0);
        assertEq(token.balanceOf(merchant), 0);
        assertEq(token.balanceOf(vault), 0);
        // These are real token transfers in the local fork, not fabricated token balances.
        vm.startPrank(FUNDER);
        token.safeTransfer(payer, 2_500_000);
        token.safeTransfer(merchant, 1_000_000);
        vm.stopPrank();
        vm.prank(payer);
        token.forceApprove(address(escrow), 2_000_000);
        vm.startPrank(merchant);
        token.forceApprove(address(escrow), 1_000_000);
        token.forceApprove(address(router), 2 * FEE);
        vm.stopPrank();

        // Only native balances are supplied by cheatcode, on the local fork.
        vm.deal(merchant, TANK_FUNDING);
        vm.prank(merchant);
        tank.deposit{value: TANK_FUNDING}(merchant);
        vm.prank(merchant);
        tank.setDailyCap(TANK_FUNDING);
        vm.deal(relayer, 0);
        vm.deal(payer, 0);
    }

    function testActualUSDTChargeRefundAndAccountingWithApiGasBudget() public {
        vm.skip(!forkEnabled, "Set FORK_RPC to opt into the pinned Whitechain fork");
        uint256 supplyBefore = token.totalSupply();
        bytes memory charge = abi.encodeCall(escrow.charge, (PAYMENT_ID, merchant, 2_000_000, uint64(1 days)));
        uint256 chargeReimbursement = _execute(PAYER_KEY, 1, 2_000_000, charge);
        assertEq(token.balanceOf(payer), 500_000);
        assertEq(token.balanceOf(merchant), 3_000_000 - FEE);
        assertEq(token.balanceOf(vault), FEE);
        _assertGasAccounting(chargeReimbursement);

        bytes memory refund = abi.encodeCall(escrow.refund, (PAYMENT_ID, 1_000_000, keccak256("customer-request")));
        uint256 refundReimbursement = _execute(MERCHANT_KEY, 2, 1_000_000, refund);
        assertEq(token.balanceOf(payer), 1_500_000);
        assertEq(token.balanceOf(merchant), 2_000_000 - 2 * FEE);
        assertEq(token.balanceOf(vault), 2 * FEE);
        assertEq(token.balanceOf(FUNDER), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(payer) + token.balanceOf(merchant) + token.balanceOf(vault), 3_500_000);
        assertEq(token.allowance(payer, address(escrow)), 0);
        assertEq(token.allowance(merchant, address(escrow)), 0);
        assertEq(token.allowance(merchant, address(router)), 0);
        _assertGasAccounting(chargeReimbursement + refundReimbursement);

        (address storedPayer, address storedMerchant, uint256 authorized, uint256 captured, uint256 refunded,,,,) =
            escrow.payments(PAYMENT_ID);
        assertEq(storedPayer, payer);
        assertEq(storedMerchant, merchant);
        assertEq(authorized, 2_000_000);
        assertEq(captured, 2_000_000);
        assertEq(refunded, 1_000_000);
        assertTrue(router.usedNonces(payer, 1));
        assertTrue(router.usedNonces(merchant, 2));
        (, uint32 payerCount) = router.payerDaily(payer);
        (, uint32 merchantCount) = router.payerDaily(merchant);
        assertEq(payerCount, 1);
        assertEq(merchantCount, 1);
        assertEq(payer.balance, 0);
        assertEq(merchant.balance, 0);
        // Inspect Router configuration after execution so these reads do not warm its gas checks.
        _assertWiring();
        emit log_named_uint("charge reimbursement wei", chargeReimbursement);
        emit log_named_uint("refund reimbursement wei", refundReimbursement);
    }

    function _execute(uint256 syntheticKey, uint256 nonce, uint256 amount, bytes memory data)
        internal
        returns (uint256 reimbursement)
    {
        Router.Intent memory intent = Router.Intent(
            vm.addr(syntheticKey),
            merchant,
            address(escrow),
            keccak256(data),
            amount,
            FEE,
            nonce,
            uint64(block.timestamp + 1 hours),
            TARGET_GAS
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(syntheticKey, router.hashIntent(intent));
        bytes memory payload = abi.encodeCall(router.execute, (intent, data, abi.encodePacked(r, s, v)));
        // Exact API execution allowance. Top-level intrinsic/calldata gas is separate.
        uint256 executionGas = uint256(TARGET_GAS) + uint256(TARGET_GAS) / 63 + 320_000;
        assertEq(executionGas, 726_349);
        vm.recordLogs();
        vm.prank(relayer);
        (bool outerOK, bytes memory result) = address(router).call{gas: executionGas}(payload);
        assertTrue(outerOK, "actual-token execution reverted at the API gas budget");
        (bool executed,) = abi.decode(result, (bool, bytes));
        assertTrue(executed, "Router refused the actual-token call");

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 executedEvents;
        uint256 feeTransfers;
        for (uint256 j; j < logs.length; ++j) {
            Vm.Log memory entry = logs[j];
            if (
                entry.emitter == address(router)
                    && entry.topics[0] == keccak256("Executed(address,address,uint256,address,uint256,uint256)")
            ) {
                executedEvents++;
                assertEq(entry.topics[1], bytes32(uint256(uint160(intent.signer))));
                assertEq(entry.topics[2], bytes32(uint256(uint160(merchant))));
                assertEq(entry.topics[3], bytes32(nonce));
                (address executedTarget, uint256 paid, uint256 paidFee) =
                    abi.decode(entry.data, (address, uint256, uint256));
                assertEq(executedTarget, address(escrow));
                assertEq(paidFee, FEE);
                reimbursement = paid;
            }
            if (
                entry.emitter == USDT && entry.topics[0] == keccak256("Transfer(address,address,uint256)")
                    && entry.topics[1] == bytes32(uint256(uint160(merchant)))
                    && entry.topics[2] == bytes32(uint256(uint160(vault)))
            ) {
                feeTransfers++;
                assertEq(abi.decode(entry.data, (uint256)), FEE);
            }
        }
        assertEq(executedEvents, 1);
        assertEq(feeTransfers, 1);
        assertGt(reimbursement, 0);
        assertLe(reimbursement, (uint256(TARGET_GAS) + 40_000) * PRICE);
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
    }

    function _assertGasAccounting(uint256 reimbursed) internal view {
        assertEq(relayer.balance, reimbursed);
        assertEq(tank.balanceOf(merchant), TANK_FUNDING - reimbursed);
        assertEq(address(tank).balance, TANK_FUNDING - reimbursed);
        (uint64 day, uint256 spent) = tank.dailySpend(merchant);
        assertEq(day, block.timestamp / 1 days);
        assertEq(spent, reimbursed);
    }

    function _assertWiring() internal view {
        assertEq(address(router.usdt()), USDT);
        assertEq(address(escrow.usdt()), USDT);
        assertEq(address(subscriptions.usdt()), USDT);
        assertEq(address(router.gasTank()), address(tank));
        assertEq(tank.router(), address(router));
        assertEq(escrow.router(), address(router));
        assertEq(subscriptions.router(), address(router));
        assertEq(subscriptions.keeper(), relayer);
        assertEq(router.owner(), address(this));
        assertEq(tank.owner(), address(this));
        assertEq(subscriptions.owner(), address(this));
        assertEq(router.feeVault(), vault);
        assertEq(router.minAmount(), 1_000_000);
        (bool enabled, bool mustReturnTrue) = router.allowed(address(subscriptions), subscriptions.charge.selector);
        assertTrue(enabled);
        assertTrue(mustReturnTrue);
    }
}
