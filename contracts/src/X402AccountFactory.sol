// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {X402AgentAccount} from "./X402AgentAccount.sol";

/// @notice Immutable provenance registry. No arbitrary registration, upgrade or delegate implementation.
/// Creating an account does not authorize merchant sponsorship or pay for its bootstrap/reservations.
contract X402AccountFactory {
    error WrongChain();
    mapping(address => bytes32) public accountCodehash;
    event AccountCreated(address indexed account, address indexed owner, bytes32 salt);

    constructor() {
        if (block.chainid != 1874) revert WrongChain();
    }

    function createAccount(address owner, bytes32 salt) external returns (X402AgentAccount account) {
        if (block.chainid != 1874) revert WrongChain();
        account = new X402AgentAccount{salt: keccak256(abi.encode(owner, salt))}(owner);
        accountCodehash[address(account)] = address(account).codehash;
        emit AccountCreated(address(account), owner, salt);
    }

    function isAccount(address account) external view returns (bool) {
        bytes32 expected = accountCodehash[account];
        return expected != bytes32(0) && account.codehash == expected;
    }
}
