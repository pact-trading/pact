// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IRouterContext {
    function activeSigner() external view returns (address);
    function activeMerchant() external view returns (address);
}

/// @notice Resolves the signed actor and merchant for a router call.
abstract contract SponsoredContext {
    error MerchantMismatch();
    address public immutable router;

    constructor(address router_) {
        router = router_;
    }

    function _actor() internal view returns (address) {
        return msg.sender == router ? IRouterContext(router).activeSigner() : msg.sender;
    }

    function _checkMerchant(address merchant) internal view {
        if (msg.sender == router && IRouterContext(router).activeMerchant() != merchant) revert MerchantMismatch();
    }
}
