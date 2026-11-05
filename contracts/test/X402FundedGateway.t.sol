// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Router} from "../src/Router.sol";
import {GasTank} from "../src/GasTank.sol";
import {X402AgentAccount} from "../src/X402AgentAccount.sol";
import {X402AccountFactory} from "../src/X402AccountFactory.sol";
import {X402FundedGateway, IX402ExactProxy, IX402UptoProxy} from "../src/X402FundedGateway.sol";
import {ISignatureTransfer} from "../x402-reference/src/interfaces/ISignatureTransfer.sol";
import {MockNoBoolUSDT} from "./mocks/MockNoBoolUSDT.sol";

// Explicit UNIT mocks only. Official Permit2/proxy cryptography and real transfers are proved
// independently by api/scripts/x402/fork-funded-gateway.ts, without etch/storage/token substitutes.
contract GatewayUnitPermit2 {
    mapping(address => mapping(uint256 => uint256)) public nonceBitmap;

    function pay(ISignatureTransfer.PermitTransferFrom calldata p, uint256 amount, address payer, address to) external {
        require(
            msg.sender == 0x402085c248EeA27D92E8b30b2C58ed07f9E20001
                || msg.sender == 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002
        );
        uint256 mask = 1 << (p.nonce & 255);
        require(nonceBitmap[payer][p.nonce >> 8] & mask == 0, "used");
        nonceBitmap[payer][p.nonce >> 8] |= mask;
        MockNoBoolUSDT(p.permitted.token).transferFrom(payer, to, amount);
    }
}

contract GatewayUnitProxy {
    address public constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    event Settled();

    function settle(
        ISignatureTransfer.PermitTransferFrom calldata p,
        address payer,
        IX402ExactProxy.Witness calldata w,
        bytes calldata
    ) external {
        GatewayUnitPermit2(PERMIT2).pay(p, p.permitted.amount, payer, w.to);
        emit Settled();
    }

    function settle(
        ISignatureTransfer.PermitTransferFrom calldata p,
        uint256 amount,
        address payer,
        IX402UptoProxy.Witness calldata w,
        bytes calldata
    ) external {
        require(msg.sender == w.facilitator && amount <= p.permitted.amount);
        GatewayUnitPermit2(PERMIT2).pay(p, amount, payer, w.to);
        emit Settled();
    }
}

contract GatewayUnitFakeFactory {
    function isAccount(address) external pure returns (bool) {
        return true;
    }
}

contract GatewayRejectsReimbursement {
    receive() external payable {
        revert("reject reimbursement");
    }
}

contract X402FundedGatewayTest is Test {
    address constant USDT = 0xcedfB56113143d55b2358b8CFbB0dEB5Ad2f55a7;
    address constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address constant EXACT = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;
    address constant UPTO = 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002;
    uint256 constant OWNER_KEY = 0x4020AA;
    uint256 constant SESSION_KEY = 0x402BEEF;
    uint256 constant MERCHANT_KEY = 0x402CAFE;
    address merchant;
    address relayer = address(0xCAFE);
    address vault = address(0xFEE);
    MockNoBoolUSDT token;
    Router router;
    GasTank tank;
    X402AccountFactory factory;
    X402AgentAccount account;
    X402FundedGateway gateway;

    function setUp() public {
        vm.chainId(1874);
        vm.warp(10 days + 1 hours);
        vm.txGasPrice(1 gwei);
        vm.etch(USDT, type(MockNoBoolUSDT).runtimeCode);
        vm.etch(PERMIT2, type(GatewayUnitPermit2).runtimeCode);
        vm.etch(EXACT, type(GatewayUnitProxy).runtimeCode);
        vm.etch(UPTO, type(GatewayUnitProxy).runtimeCode);
        token = MockNoBoolUSDT(USDT);
        merchant = vm.addr(MERCHANT_KEY);
        tank = new GasTank();
        router = new Router(IERC20(USDT), tank, vault);
        tank.setRouter(address(router));
        router.setLimits(1, 1_000_000, 100, 1_000_000, 10 gwei);
        factory = new X402AccountFactory();
        gateway = _gateway(10, 20, 30);
        account = _account(bytes32(uint256(1)));
        token.mint(merchant, 1_000_000);
        vm.prank(merchant);
        token.approve(address(router), 1_000_000);
        vm.deal(merchant, 1 ether);
        vm.prank(merchant);
        tank.deposit{value: 1 ether}(merchant);
        vm.prank(merchant);
        tank.setDailyCap(1 ether);
    }

    function _gateway(uint32 a, uint32 m, uint32 g) private returns (X402FundedGateway result) {
        result = new X402FundedGateway(router, factory, X402FundedGateway.Limits(100_000, a, m, g));
        router.setAllowed(address(result), result.settleExact.selector, true, true);
        router.setAllowed(address(result), result.settleUpto.selector, true, true);
    }

    function _sig(uint256 key, bytes32 digest) private pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    function _account(bytes32 salt) private returns (X402AgentAccount result) {
        result = factory.createAccount(vm.addr(OWNER_KEY), salt);
        address[] memory allowed = new address[](1);
        allowed[0] = merchant;
        vm.prank(vm.addr(OWNER_KEY));
        result.configureSession(vm.addr(SESSION_KEY), 100_000, 1_000_000, block.timestamp + 3600, allowed);
        token.mint(address(result), 1_000_000);
        bytes memory sig = _sig(OWNER_KEY, result.bootstrapDigest(1_000_000, 0, block.timestamp + 120));
        result.bootstrap(1_000_000, block.timestamp + 120, sig);
    }

    function _permit(uint256 nonce, uint256 ceiling)
        private
        view
        returns (ISignatureTransfer.PermitTransferFrom memory)
    {
        return ISignatureTransfer.PermitTransferFrom(
            ISignatureTransfer.TokenPermissions(USDT, ceiling), nonce, block.timestamp + 120
        );
    }

    function _reserved(uint256 nonce, bool upto)
        private
        returns (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig)
    {
        p = _permit(nonce, 10_000);
        X402AgentAccount.Payment memory payment = X402AgentAccount.Payment(
            upto ? UPTO : EXACT, 10_000, nonce, p.deadline, merchant, upto ? address(gateway) : address(0), 0
        );
        sig = _sig(SESSION_KEY, account.sessionDigest(account.permitDigest(payment)));
        account.reserve(payment, sig);
    }

    function _data(uint256 nonce, bool upto) private returns (bytes memory) {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(nonce, upto);
        if (upto) {
            return abi.encodeCall(
                gateway.settleUpto,
                (p, 4_000, address(account), IX402UptoProxy.Witness(merchant, address(gateway), 0), sig)
            );
        }
        return abi.encodeCall(gateway.settleExact, (p, address(account), IX402ExactProxy.Witness(merchant, 0), sig));
    }

    function _intent(bytes memory data, uint256 amount, uint256 nonce) private view returns (Router.Intent memory) {
        return Router.Intent(
            merchant,
            merchant,
            address(gateway),
            keccak256(data),
            amount,
            1_000,
            nonce,
            uint64(block.timestamp + 120),
            500_000
        );
    }

    function _execute(bytes memory data, uint256 amount, uint256 nonce) private returns (bool ok) {
        Router.Intent memory i = _intent(data, amount, nonce);
        bytes memory signature = _sig(MERCHANT_KEY, router.hashIntent(i));
        vm.prank(relayer);
        (ok,) = router.execute{gas: 1_000_000}(i, data, signature);
    }

    function testExactAndUptoViaRealRouterUnitToken() public {
        uint256 beforeTank = tank.balanceOf(merchant);
        assertTrue(_execute(_data(1, false), 10_000, 1));
        assertTrue(_execute(_data(2, true), 4_000, 2));
        assertEq(token.balanceOf(address(account)), 986_000);
        assertEq(token.balanceOf(merchant), 1_012_000);
        assertEq(token.balanceOf(vault), 2_000);
        assertEq(beforeTank - tank.balanceOf(merchant), relayer.balance);
        assertGt(relayer.balance, 0);
        assertEq(account.reservedPerDay(10), 20_000);
        (, uint32 calls) = gateway.accountDaily(address(account));
        assertEq(calls, 2);
    }

    function testDirectAndAbsentRouterContextRefused() public {
        bytes memory data = _data(1, false);
        vm.expectRevert(X402FundedGateway.InvalidContext.selector);
        (bool ok,) = address(gateway).call(data);
        ok;
        vm.prank(address(router));
        vm.expectRevert(X402FundedGateway.InvalidContext.selector);
        (ok,) = address(gateway).call(data);
        ok;
    }

    function testValidNonMerchantRouterSignatureCannotSpendMerchantTank() public {
        bytes memory data = _data(1, false);
        Router.Intent memory i = _intent(data, 10_000, 1);
        i.signer = vm.addr(OWNER_KEY);
        bytes memory signature = _sig(OWNER_KEY, router.hashIntent(i));
        uint256 beforeTank = tank.balanceOf(merchant);
        vm.prank(relayer);
        (bool ok,) = router.execute{gas: 1_000_000}(i, data, signature);
        assertFalse(ok);
        assertEq(tank.balanceOf(merchant), beforeTank);
        assertEq(token.balanceOf(vault), 0);
        assertEq(token.balanceOf(address(account)), 1_000_000);
        assertTrue(router.usedNonces(i.signer, 1));
    }

    function testWrongMerchantOrAlteredSignedCalldataRefusedByRouter() public {
        bytes memory data = _data(1, false);
        Router.Intent memory i = _intent(data, 10_000, 1);
        bytes memory signature = _sig(MERCHANT_KEY, router.hashIntent(i));
        vm.prank(relayer);
        (bool ok,) = router.execute(i, bytes.concat(data, hex"00"), signature);
        assertFalse(ok);
        i.amount++;
        signature = _sig(MERCHANT_KEY, router.hashIntent(i));
        vm.prank(relayer);
        (ok,) = router.execute{gas: 1_000_000}(i, data, signature);
        assertFalse(ok);
        assertEq(token.balanceOf(vault), 0);
        assertFalse(router.usedNonces(merchant, 1));
    }

    function testOnlyFactoryCreatedRuntimeAccepted() public {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, false);
        X402AgentAccount impostor = new X402AgentAccount(vm.addr(OWNER_KEY));
        bytes memory data =
            abi.encodeCall(gateway.settleExact, (p, address(impostor), IX402ExactProxy.Witness(merchant, 0), sig));
        vm.expectRevert(X402FundedGateway.UnapprovedAccount.selector);
        gateway.sponsorshipQuote(data);
        vm.etch(address(account), hex"60006000fd");
        data = abi.encodeCall(gateway.settleExact, (p, address(account), IX402ExactProxy.Witness(merchant, 0), sig));
        vm.expectRevert(X402FundedGateway.UnapprovedAccount.selector);
        gateway.sponsorshipQuote(data);
    }

    function testFakeFactoryAndWrongChainDeploymentRefused() public {
        GatewayUnitFakeFactory fake = new GatewayUnitFakeFactory();
        vm.expectRevert(X402FundedGateway.InvalidConfig.selector);
        new X402FundedGateway(router, X402AccountFactory(address(fake)), X402FundedGateway.Limits(10, 1, 1, 1));
        vm.chainId(1);
        vm.expectRevert(X402AccountFactory.WrongChain.selector);
        new X402AccountFactory();
        vm.expectRevert(X402FundedGateway.InvalidConfig.selector);
        new X402FundedGateway(router, factory, X402FundedGateway.Limits(10, 1, 1, 1));
    }

    function testTokenFacilitatorRecipientAndSignatureBound() public {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, true);
        IX402UptoProxy.Witness memory w = IX402UptoProxy.Witness(merchant, address(gateway), 0);
        p.permitted.token = address(1);
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 4_000, address(account), w, sig)));
        p.permitted.token = USDT;
        w.facilitator = relayer;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 4_000, address(account), w, sig)));
        w.facilitator = address(gateway);
        w.to = address(123);
        vm.expectRevert(X402FundedGateway.InvalidAuthorization.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 4_000, address(account), w, sig)));
        w.to = merchant;
        sig[0] = bytes1(uint8(sig[0]) ^ 1);
        vm.expectRevert(X402FundedGateway.InvalidAuthorization.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 4_000, address(account), w, sig)));
    }

    function testAmountWindowAndSignatureLengthBounds() public {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, true);
        IX402UptoProxy.Witness memory w = IX402UptoProxy.Witness(merchant, address(gateway), 0);
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 0, address(account), w, sig)));
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 10_001, address(account), w, sig)));
        p.deadline = block.timestamp + 301;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 1, address(account), w, sig)));
        p.deadline = block.timestamp - 1;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 1, address(account), w, sig)));
        p.deadline = block.timestamp + 120;
        w.validAfter = block.timestamp + 1;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 1, address(account), w, sig)));
        w.validAfter = 0;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(abi.encodeCall(gateway.settleUpto, (p, 1, address(account), w, hex"12")));
    }

    function testCanonicalCalldataAndAdminSelectorsDisabled() public {
        bytes memory data = _data(1, false);
        vm.expectRevert(X402FundedGateway.InvalidCall.selector);
        gateway.sponsorshipQuote(bytes.concat(data, hex"00"));
        vm.expectRevert(X402FundedGateway.InvalidCall.selector);
        gateway.sponsorshipQuote(
            abi.encodeWithSelector(X402AgentAccount.bootstrap.selector, 10_000, block.timestamp + 120, new bytes(65))
        );
        vm.expectRevert(X402FundedGateway.InvalidCall.selector);
        gateway.sponsorshipQuote(hex"12345678");
        vm.expectRevert(X402FundedGateway.InvalidCall.selector);
        gateway.sponsorshipQuote(new bytes(453));
        // Even if a future owner accidentally allowlists an unknown selector, quoting refuses it.
        router.setAllowed(address(gateway), X402AgentAccount.bootstrap.selector, true, true);
        assertFalse(
            _execute(
                abi.encodeWithSelector(
                    X402AgentAccount.bootstrap.selector, 10_000, block.timestamp + 120, new bytes(65)
                ),
                10_000,
                1
            )
        );
    }

    function testReplayRevocationAndRuntimeChangesRefused() public {
        bytes memory data = _data(1, false);
        assertTrue(_execute(data, 10_000, 1));
        vm.expectRevert(X402FundedGateway.PermitUsed.selector);
        gateway.sponsorshipQuote(data);
        data = _data(2, false);
        vm.prank(vm.addr(OWNER_KEY));
        account.revokeSession();
        vm.expectRevert(X402FundedGateway.InvalidAuthorization.selector);
        gateway.sponsorshipQuote(data);
        vm.etch(EXACT, hex"00");
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(data);
    }

    function testAccountDailyLimitAndNoCounterOnFailedTransfer() public {
        gateway = _gateway(1, 10, 10);
        bytes memory data = _data(1, false);
        token.setFailTransfers(true);
        assertFalse(_execute(data, 10_000, 1));
        (, uint32 calls) = gateway.accountDaily(address(account));
        assertEq(calls, 0);
        token.setFailTransfers(false);
        assertTrue(_execute(data, 10_000, 2));
        data = _data(2, false);
        vm.expectRevert(X402FundedGateway.DailyCap.selector);
        gateway.sponsorshipQuote(data);
    }

    function testMerchantAndGlobalLimitsAcrossAccounts() public {
        gateway = _gateway(10, 1, 10);
        assertTrue(_execute(_data(1, false), 10_000, 1));
        account = _account(bytes32(uint256(2)));
        bytes memory data = _data(1, false);
        vm.expectRevert(X402FundedGateway.DailyCap.selector);
        gateway.sponsorshipQuote(data);
        gateway = _gateway(10, 10, 1);
        assertTrue(_execute(_data(2, false), 10_000, 2));
        account = _account(bytes32(uint256(3)));
        data = _data(1, false);
        vm.expectRevert(X402FundedGateway.DailyCap.selector);
        gateway.sponsorshipQuote(data);
    }

    function testDepletedTankOrMissingFeeNeverTransfers() public {
        bytes memory data = _data(1, false);
        vm.prank(merchant);
        tank.withdraw(1 ether);
        assertFalse(_execute(data, 10_000, 1));
        vm.prank(merchant);
        tank.deposit{value: 1 ether}(merchant);
        vm.prank(merchant);
        token.approve(address(router), 0);
        assertFalse(_execute(data, 10_000, 2));
        assertEq(token.balanceOf(address(account)), 1_000_000);
        assertEq(token.balanceOf(vault), 0);
    }

    function testReimbursementFailureRollsBackPaymentFeeNonceAndCounters() public {
        bytes memory data = _data(1, false);
        Router.Intent memory i = _intent(data, 10_000, 1);
        bytes memory signature = _sig(MERCHANT_KEY, router.hashIntent(i));
        GatewayRejectsReimbursement reject = new GatewayRejectsReimbursement();
        uint256 beforeTank = tank.balanceOf(merchant);
        vm.prank(address(reject));
        vm.expectRevert("WBT transfer failed");
        router.execute{gas: 1_000_000}(i, data, signature);
        assertEq(token.balanceOf(address(account)), 1_000_000);
        assertEq(token.balanceOf(merchant), 1_000_000);
        assertEq(token.balanceOf(vault), 0);
        assertEq(tank.balanceOf(merchant), beforeTank);
        assertEq(GatewayUnitPermit2(PERMIT2).nonceBitmap(address(account), 0), 0);
        assertFalse(router.usedNonces(merchant, 1));
        (, uint32 calls) = gateway.accountDaily(address(account));
        assertEq(calls, 0);
        assertEq(account.reservedPerDay(10), 10_000); // Earlier unfunded reservation remains.
    }

    function testProxyReturningWithoutTransferIsNotFundedSuccess() public {
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, false);
        IX402ExactProxy.Witness memory w = IX402ExactProxy.Witness(merchant, 0);
        vm.mockCall(EXACT, abi.encodeCall(IX402ExactProxy.settle, (p, address(account), w, sig)), bytes(""));
        bytes memory data = abi.encodeCall(gateway.settleExact, (p, address(account), w, sig));
        assertFalse(_execute(data, 10_000, 1));
        assertEq(token.balanceOf(vault), 0);
        assertEq(token.balanceOf(address(account)), 1_000_000);
        (, uint32 calls) = gateway.accountDaily(address(account));
        assertEq(calls, 0);
    }

    function testFuzzGatewayCeiling(uint256 ceiling) public {
        ceiling = bound(ceiling, 100_001, type(uint128).max);
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, true);
        p.permitted.amount = ceiling;
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(
            abi.encodeCall(
                gateway.settleUpto, (p, 1, address(account), IX402UptoProxy.Witness(merchant, address(gateway), 0), sig)
            )
        );
    }

    function testFuzzActualCannotExceedCeiling(uint256 amount) public {
        amount = bound(amount, 10_001, type(uint128).max);
        (ISignatureTransfer.PermitTransferFrom memory p, bytes memory sig) = _reserved(1, true);
        vm.expectRevert(X402FundedGateway.InvalidPayment.selector);
        gateway.sponsorshipQuote(
            abi.encodeCall(
                gateway.settleUpto,
                (p, amount, address(account), IX402UptoProxy.Witness(merchant, address(gateway), 0), sig)
            )
        );
    }
}
