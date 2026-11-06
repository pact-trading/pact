// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {FeeSchedule} from "../src/FeeSchedule.sol";
import {Router} from "../src/Router.sol";
import {PaymentEscrow} from "../src/PaymentEscrow.sol";
import {SubscriptionManagerV2} from "../src/SubscriptionManagerV2.sol";
import {SuiteDeployment} from "../script/Deploy.s.sol";

/// @notice Opt-in, local EVM fork only: FORK_RPC=<archive RPC> forge test --match-contract WhitechainForkSmokeTest -vv
/// No broadcasts, real signing keys, token mocks, minting or token-storage overrides. Uses Whitechain's
/// real USDT, including its EIP-2612 permit, which is how merchants and customers approve without gas.
contract WhitechainForkSmokeTest is Test, SuiteDeployment {
    using SafeERC20 for IERC20;

    uint256 constant FORK_BLOCK = 11_924_802;
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address constant FUNDER = 0xC0DFd2a61DF78dF2e8b491a90e3765Fbf480689a;
    // Public synthetic test keys, never loaded from the environment or used outside this fork.
    uint256 constant PAYER_KEY = 0xA11CE55;
    uint256 constant MERCHANT_KEY = 0xBEEF55;
    uint32 constant TARGET_GAS = 400_000;
    uint256 constant PRICE = 5_001_000_000;
    uint256 constant USDT_PER_WBT = 79_000_000;
    uint256 constant FEE = 150_000; // 0.8% of 2 USDT is under the 0.15 USDT floor.
    bytes32 constant PAYMENT_ID = keccak256("pinned-whitechain-fork-smoke");
    bytes32 constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    IERC20 token;
    FeeSchedule fees;
    Router router;
    PaymentEscrow escrow;
    SubscriptionManagerV2 subscriptions;
    address payer;
    address merchant;
    address relayer;
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
        token = IERC20(USDT);

        // Same wiring and allowlist as Deploy.s.sol.
        (fees, router, escrow, subscriptions) = _deploySuite(token, relayer, relayer, USDT_PER_WBT);

        assertEq(token.balanceOf(FUNDER), 3_500_000);
        assertEq(token.balanceOf(payer), 0);
        assertEq(token.balanceOf(merchant), 0);
        assertEq(token.balanceOf(relayer), 0);
        // These are real token transfers in the local fork, not fabricated token balances.
        vm.startPrank(FUNDER);
        token.safeTransfer(payer, 2_500_000);
        token.safeTransfer(merchant, 1_000_000);
        vm.stopPrank();
        // Nobody but the relayer holds WBT: every approval and acceptance is a signature it submits.
        vm.deal(relayer, 1 ether);
        vm.deal(payer, 0);
        vm.deal(merchant, 0);
        vm.startPrank(relayer);
        _permit(PAYER_KEY, address(escrow), 2_000_000);
        _permit(MERCHANT_KEY, address(escrow), 1_000_000);
        _permit(MERCHANT_KEY, address(router), 1_000_000);
        uint256 deadline = block.timestamp + 1 hours;
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(MERCHANT_KEY, fees.hashAcceptance(merchant, 1, 0, deadline));
        fees.acceptWithSig(merchant, 1, deadline, abi.encodePacked(r, s, v));
        vm.stopPrank();
    }

    function _permit(uint256 key, address spender, uint256 value) internal {
        address owner = vm.addr(key);
        uint256 deadline = block.timestamp + 1 hours;
        bytes32 structHash =
            keccak256(abi.encode(PERMIT_TYPEHASH, owner, spender, value, IERC20Permit(USDT).nonces(owner), deadline));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(key, keccak256(abi.encodePacked("\x19\x01", IERC20Permit(USDT).DOMAIN_SEPARATOR(), structHash)));
        IERC20Permit(USDT).permit(owner, spender, value, deadline, v, r, s);
        assertEq(token.allowance(owner, spender), value);
    }

    function testActualUSDTChargeRefundAndFeesWithApiGasBudget() public {
        vm.skip(!forkEnabled, "Set FORK_RPC to opt into the pinned Whitechain fork");
        uint256 supplyBefore = token.totalSupply();
        bytes memory charge = abi.encodeCall(escrow.charge, (PAYMENT_ID, merchant, 2_000_000, uint64(1 days)));
        assertEq(_execute(PAYER_KEY, 1, 2_000_000, charge), 0);
        assertEq(token.balanceOf(payer), 500_000);
        assertEq(token.balanceOf(merchant), 3_000_000 - FEE);
        assertEq(token.balanceOf(relayer), FEE);

        bytes memory refund = abi.encodeCall(escrow.refund, (PAYMENT_ID, 1_000_000, keccak256("customer-request")));
        uint256 gasFee = _execute(MERCHANT_KEY, 2, 1_000_000, refund);
        assertGt(gasFee, 0);
        assertLe(gasFee, router.maxGasFee(TARGET_GAS, PRICE));
        assertEq(token.balanceOf(payer), 1_500_000);
        assertEq(token.balanceOf(merchant), 2_000_000 - FEE - gasFee);
        assertEq(token.balanceOf(relayer), FEE + gasFee);
        assertEq(token.balanceOf(FUNDER), 0);
        assertEq(token.balanceOf(address(escrow)), 0);
        assertEq(token.balanceOf(address(router)), 0);
        assertEq(token.totalSupply(), supplyBefore);
        assertEq(token.balanceOf(payer) + token.balanceOf(merchant) + token.balanceOf(relayer), 3_500_000);
        assertEq(token.allowance(payer, address(escrow)), 0);
        assertEq(token.allowance(merchant, address(escrow)), 0);
        assertEq(token.allowance(merchant, address(router)), 1_000_000 - gasFee);

        (address storedPayer, address storedMerchant, uint256 authorized, uint256 captured, uint256 refunded,,,,) =
            escrow.payments(PAYMENT_ID);
        assertEq(storedPayer, payer);
        assertEq(storedMerchant, merchant);
        assertEq(authorized, 2_000_000);
        assertEq(captured, 2_000_000);
        assertEq(refunded, 1_000_000);
        assertTrue(router.usedNonces(payer, 1));
        assertTrue(router.usedNonces(merchant, 2));
        assertEq(payer.balance, 0);
        assertEq(merchant.balance, 0);
        // Inspect configuration after execution so these reads do not warm its gas checks.
        _assertWiring();
        emit log_named_uint("refund gas fee (USDT base units)", gasFee);
    }

    function _execute(uint256 syntheticKey, uint256 nonce, uint256 amount, bytes memory data)
        internal
        returns (uint256 gasFee)
    {
        Router.Intent memory intent = Router.Intent(
            vm.addr(syntheticKey),
            merchant,
            address(escrow),
            keccak256(data),
            amount,
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
        for (uint256 j; j < logs.length; ++j) {
            Vm.Log memory entry = logs[j];
            if (
                entry.emitter == address(router)
                    && entry.topics[0] == keccak256("Executed(address,address,uint256,address,uint256)")
            ) {
                executedEvents++;
                assertEq(entry.topics[1], bytes32(uint256(uint160(intent.signer))));
                assertEq(entry.topics[2], bytes32(uint256(uint160(merchant))));
                assertEq(entry.topics[3], bytes32(nonce));
                (address executedTarget, uint256 charged) = abi.decode(entry.data, (address, uint256));
                assertEq(executedTarget, address(escrow));
                gasFee = charged;
            }
        }
        assertEq(executedEvents, 1);
        assertEq(router.activeSigner(), address(0));
        assertEq(router.activeMerchant(), address(0));
    }

    function _assertWiring() internal view {
        assertEq(address(router.usdt()), USDT);
        assertEq(address(escrow.usdt()), USDT);
        assertEq(address(subscriptions.usdt()), USDT);
        assertEq(address(router.fees()), address(fees));
        assertEq(address(escrow.fees()), address(fees));
        assertEq(address(subscriptions.fees()), address(fees));
        assertEq(escrow.router(), address(router));
        assertEq(subscriptions.router(), address(router));
        assertEq(subscriptions.keeper(), relayer);
        assertEq(router.owner(), address(this));
        assertEq(fees.owner(), address(this));
        assertEq(subscriptions.owner(), address(this));
        assertEq(fees.recipient(), relayer);
        assertEq(router.minAmount(), 1_000_000);
        (bool enabled, bool mustReturnTrue,,) = router.allowed(address(subscriptions), subscriptions.charge.selector);
        assertTrue(enabled);
        assertTrue(mustReturnTrue);
    }
}
