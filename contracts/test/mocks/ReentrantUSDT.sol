// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {MockNoBoolUSDT} from "./MockNoBoolUSDT.sol";

/// @notice A hostile token: on its next transfer it calls `target` with `data` (once), and records
/// whether that reentrant call succeeded and what it returned.
contract ReentrantUSDT is MockNoBoolUSDT {
    address public target;
    bytes public data;
    bool public attempted;
    bool public reentered;
    bytes public reentryResult;

    function arm(address target_, bytes calldata data_) external {
        target = target_;
        data = data_;
        attempted = false;
    }

    function _transfer(address from, address to, uint256 amount) internal override {
        if (target != address(0) && !attempted) {
            attempted = true;
            (reentered, reentryResult) = target.call(data);
        }
        super._transfer(from, to, amount);
    }
}
