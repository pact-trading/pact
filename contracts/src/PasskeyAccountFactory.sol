// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {PasskeyAccount} from "./PasskeyAccount.sol";

/// @notice Deterministic passkey accounts: the address follows from the passkey's public key and a
/// salt, so a customer has an address (and can be paid) before the account exists. Anyone may create
/// an account; creating an existing one returns it.
contract PasskeyAccountFactory {
    PasskeyAccount public immutable implementation;

    event AccountCreated(address indexed account, bytes32 x, bytes32 y, uint256 salt);

    constructor(IERC20 usdt, address permit2) {
        implementation = new PasskeyAccount(usdt, permit2, address(this));
    }

    function createAccount(bytes32 x, bytes32 y, uint256 salt) external returns (PasskeyAccount account) {
        bytes32 key = _salt(x, y, salt);
        address predicted = Clones.predictDeterministicAddress(address(implementation), key);
        if (predicted.code.length != 0) return PasskeyAccount(payable(predicted));
        account = PasskeyAccount(payable(Clones.cloneDeterministic(address(implementation), key)));
        account.initialize(x, y);
        emit AccountCreated(address(account), x, y, salt);
    }

    function accountAddress(bytes32 x, bytes32 y, uint256 salt) external view returns (address) {
        return Clones.predictDeterministicAddress(address(implementation), _salt(x, y, salt));
    }

    function _salt(bytes32 x, bytes32 y, uint256 salt) private pure returns (bytes32) {
        return keccak256(abi.encode(x, y, salt));
    }
}
