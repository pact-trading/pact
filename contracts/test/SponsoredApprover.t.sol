// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {SponsoredApprover} from "../src/SponsoredApprover.sol";
import {MockNoBoolUSDT} from "./mocks/MockNoBoolUSDT.sol";

contract SponsoredApproverTest is Test {
    SponsoredApprover delegateCode;
    MockNoBoolUSDT token;
    uint256 payerKey = 0xA11CE;
    address payer;
    address relayer = address(0xBEEF);
    address spender = address(0x5E11);

    function setUp() public {
        delegateCode = new SponsoredApprover();
        token = new MockNoBoolUSDT();
        payer = vm.addr(payerKey);
        vm.deal(relayer, 1 ether);
        vm.signAndAttachDelegation(address(delegateCode), payerKey);
    }

    function _sign(uint256 key, address tok, address sp, uint256 amount, uint256 nonce, uint256 deadline) internal view returns (bytes memory) {
        bytes32 h = delegateCode.approvalHash(tok, sp, amount, nonce, deadline); // chainid/address(this) differ, rebuilt below
        h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", keccak256(abi.encode(block.chainid, payer, tok, sp, amount, nonce, deadline))));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function test_relayerPaysGasPayerApproves() public {
        bytes memory sig = _sign(payerKey, address(token), spender, 1_000_000, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        SponsoredApprover(payer).approveFor(address(token), spender, 1_000_000, block.timestamp + 1 hours, sig);
        assertEq(token.allowance(payer, spender), 1_000_000);
        assertEq(SponsoredApprover(payer).approvalNonce(), 1);
    }

    function test_replayRefused() public {
        bytes memory sig = _sign(payerKey, address(token), spender, 1_000_000, 0, block.timestamp + 1 hours);
        vm.startPrank(relayer);
        SponsoredApprover(payer).approveFor(address(token), spender, 1_000_000, block.timestamp + 1 hours, sig);
        vm.expectRevert(SponsoredApprover.InvalidSignature.selector);
        SponsoredApprover(payer).approveFor(address(token), spender, 1_000_000, block.timestamp + 1 hours, sig);
        vm.stopPrank();
    }

    function test_otherSpenderRefused() public {
        bytes memory sig = _sign(payerKey, address(token), spender, 1_000_000, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        vm.expectRevert(SponsoredApprover.InvalidSignature.selector);
        SponsoredApprover(payer).approveFor(address(token), address(0xBAD), 1_000_000, block.timestamp + 1 hours, sig);
    }

    function test_wrongSignerRefused() public {
        bytes memory sig = _sign(0xB0B, address(token), spender, 1_000_000, 0, block.timestamp + 1 hours);
        vm.prank(relayer);
        vm.expectRevert(SponsoredApprover.InvalidSignature.selector);
        SponsoredApprover(payer).approveFor(address(token), spender, 1_000_000, block.timestamp + 1 hours, sig);
    }

    function test_expiredRefused() public {
        bytes memory sig = _sign(payerKey, address(token), spender, 1_000_000, 0, block.timestamp - 1);
        vm.prank(relayer);
        vm.expectRevert(SponsoredApprover.Expired.selector);
        SponsoredApprover(payer).approveFor(address(token), spender, 1_000_000, block.timestamp - 1, sig);
    }
}
