// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;
import {Test} from "forge-std/Test.sol";
import {X402AgentAccount} from "../src/X402AgentAccount.sol";

/// Pure policy tests. Actual USDT bootstrap/transfers are tested by api/scripts/x402/fork.ts.
contract X402AgentAccountTest is Test {
    X402AgentAccount account;
    uint256 constant SESSION_KEY = 0x402BEEF;
    address merchant = address(0x1234);
    function setUp() public {
        vm.chainId(1874);
        vm.warp(10 days + 1 hours);
        account = new X402AgentAccount(address(this));
        _configure(10, 100);
    }
    function _configure(uint256 perCall, uint256 daily) internal {
        address[] memory merchants = new address[](1); merchants[0] = merchant;
        account.configureSession(vm.addr(SESSION_KEY), perCall, daily, block.timestamp + 1 days, merchants);
    }
    function _payment(uint256 nonce) internal view returns (X402AgentAccount.Payment memory) {
        return X402AgentAccount.Payment(account.EXACT(), 10, nonce, block.timestamp + 120, merchant, address(0), 0);
    }
    function _sign(X402AgentAccount.Payment memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SESSION_KEY, account.sessionDigest(account.permitDigest(p)));
        return abi.encodePacked(r, s, v);
    }
    function testTenReservationsAndEleventhDailyRefusal() public {
        for (uint256 i; i < 10; ++i) { X402AgentAccount.Payment memory p = _payment(i); account.reserve(p, _sign(p)); }
        X402AgentAccount.Payment memory p = _payment(11); bytes memory sig = _sign(p);
        vm.expectRevert(X402AgentAccount.DailyCap.selector); account.reserve(p, sig);
        assertEq(account.reservedPerDay(10), 100);
    }
    function testPerCallAndMerchantRefusals() public {
        X402AgentAccount.Payment memory p = _payment(0); p.amount = 11;
        bytes memory sig = _sign(p); vm.expectRevert(X402AgentAccount.PerCallCap.selector); account.reserve(p, sig);
        p.amount = 10; p.to = address(0x666); sig = _sign(p);
        vm.expectRevert(X402AgentAccount.MerchantDenied.selector); account.reserve(p, sig);
        assertEq(account.reservedPerDay(10), 0);
    }
    function testReservationReplayAndStaticSignature() public {
        X402AgentAccount.Payment memory p = _payment(1); bytes memory sig = _sign(p);
        bytes32 digest = account.permitDigest(p);
        assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
        account.reserve(p, sig);
        assertEq(account.isValidSignature(digest, sig), bytes4(0x1626ba7e));
        vm.expectRevert(X402AgentAccount.AlreadyReserved.selector); account.reserve(p, sig);
        assertEq(account.reservedPerDay(10), 10);
    }
    function testRevokeInvalidatesAlreadyReservedAuthorization() public {
        X402AgentAccount.Payment memory p = _payment(1); bytes memory sig = _sign(p); bytes32 digest = account.reserve(p, sig);
        account.revokeSession(); assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
        p = _payment(2); vm.expectRevert(X402AgentAccount.SessionExpired.selector); account.reserve(p, sig);
    }
    function testPolicyRotationCannotResetDailySpend() public {
        X402AgentAccount.Payment memory p = _payment(1); account.reserve(p, _sign(p));
        _configure(10, 10); p = _payment(2); bytes memory sig = _sign(p);
        vm.expectRevert(X402AgentAccount.DailyCap.selector); account.reserve(p, sig);
    }
    function testCrossAccountReplayRejected() public {
        X402AgentAccount.Payment memory p = _payment(1); bytes memory sig = _sign(p);
        X402AgentAccount second = new X402AgentAccount(address(this));
        address[] memory merchants = new address[](1); merchants[0] = merchant;
        second.configureSession(vm.addr(SESSION_KEY), 10, 100, block.timestamp + 1 days, merchants);
        vm.expectRevert(X402AgentAccount.Unauthorized.selector); second.reserve(p, sig);
    }
    function testCrossChainReplayRejected() public {
        X402AgentAccount.Payment memory p = _payment(1); bytes memory sig = _sign(p);
        vm.chainId(1); vm.expectRevert(X402AgentAccount.Unauthorized.selector); account.reserve(p, sig);
    }
    function testCannotCarryReservationIntoAnotherDay() public {
        X402AgentAccount.Payment memory p = _payment(1); p.deadline = 11 days;
        bytes memory sig = _sign(p); vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.reserve(p, sig);
        p.deadline = 11 days - 1; sig = _sign(p); bytes32 digest = account.reserve(p, sig);
        vm.warp(11 days); assertEq(account.isValidSignature(digest, sig), bytes4(0xffffffff));
    }
    function testExpiredFutureAndSessionWindowRefused() public {
        X402AgentAccount.Payment memory p = _payment(1); p.deadline = block.timestamp - 1;
        bytes memory sig = _sign(p); vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.reserve(p, sig);
        p = _payment(2); p.validAfter = block.timestamp + 1;
        sig = _sign(p); vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.reserve(p, sig);
        vm.warp(block.timestamp + 1 days); p = _payment(3); sig = _sign(p);
        vm.expectRevert(X402AgentAccount.SessionExpired.selector); account.reserve(p, sig);
    }
    function testUptoReservesFullCeiling() public {
        X402AgentAccount.Payment memory p = _payment(1); p.spender = account.UPTO(); p.facilitator = address(0x777);
        account.reserve(p, _sign(p)); assertEq(account.reservedPerDay(10), 10);
    }
    function testBootstrapBoundsBeforeTokenCall() public {
        vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.bootstrap(100_000_001, block.timestamp + 1, hex"");
        vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.bootstrap(1, block.timestamp + 601, hex"");
        vm.expectRevert(X402AgentAccount.InvalidWindow.selector); account.bootstrap(1, block.timestamp - 1, hex"");
        assertEq(account.approvalNonce(), 0);
    }
    function testUnauthorizedPolicyAndWithdrawal() public {
        vm.prank(address(7)); vm.expectRevert(X402AgentAccount.Unauthorized.selector); account.revokeSession();
        vm.prank(address(7)); vm.expectRevert(X402AgentAccount.Unauthorized.selector); account.withdraw(address(7), 1);
    }
    function testOwnerSignedSessionChangeAndRevocation() public {
        uint256 ownerKey = 0x0A11CE;
        X402AgentAccount owned = new X402AgentAccount(vm.addr(ownerKey));
        address[] memory merchants = new address[](1); merchants[0] = merchant;
        uint256 deadline = block.timestamp + 300;
        bytes32 digest = owned.sessionChangeDigest(vm.addr(SESSION_KEY), 10, 100, block.timestamp + 1 days, merchants, 0, deadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);
        bytes memory sig = abi.encodePacked(r, s, v);
        // Anyone may relay it; a different limit or a second use is refused.
        vm.prank(address(9)); vm.expectRevert(X402AgentAccount.Unauthorized.selector);
        owned.configureSessionWithSig(vm.addr(SESSION_KEY), 11, 100, block.timestamp + 1 days, merchants, deadline, sig);
        vm.prank(address(9));
        owned.configureSessionWithSig(vm.addr(SESSION_KEY), 10, 100, block.timestamp + 1 days, merchants, deadline, sig);
        assertEq(owned.sessionKey(), vm.addr(SESSION_KEY));
        assertEq(owned.perCallCap(), 10);
        vm.expectRevert(X402AgentAccount.Unauthorized.selector);
        owned.configureSessionWithSig(vm.addr(SESSION_KEY), 10, 100, block.timestamp + 1 days, merchants, deadline, sig);
        // A signature from someone else, or outside its window, is refused.
        (v, r, s) = vm.sign(0xBAD, owned.revokeDigest(2, deadline));
        vm.expectRevert(X402AgentAccount.Unauthorized.selector); owned.revokeSessionWithSig(deadline, abi.encodePacked(r, s, v));
        vm.expectRevert(X402AgentAccount.InvalidWindow.selector); owned.revokeSessionWithSig(block.timestamp + 601, hex"");
        (v, r, s) = vm.sign(ownerKey, owned.revokeDigest(owned.approvalNonce(), deadline));
        owned.revokeSessionWithSig(deadline, abi.encodePacked(r, s, v));
        assertEq(owned.sessionKey(), address(0));
    }
    function testFuzzPerCallCeiling(uint256 amount) public {
        amount = bound(amount, 11, type(uint128).max);
        X402AgentAccount.Payment memory p = _payment(1); p.amount = amount; bytes memory sig = _sign(p);
        vm.expectRevert(X402AgentAccount.PerCallCap.selector); account.reserve(p, sig);
        assertEq(account.reservedPerDay(10), 0);
    }
}
