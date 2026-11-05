// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice Merchant-owned WBT balances with a daily reimbursement ceiling.
contract GasTank is ReentrancyGuard {
    error NotAuthorized();
    error InsufficientTank();
    error DailyCapExceeded();
    error InvalidValue();

    struct Daily {
        uint64 day;
        uint256 spent;
    }
    address public owner;
    address public router;
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public dailyCap;
    mapping(address => Daily) public dailySpend;
    event Deposited(address indexed merchant, address indexed funder, uint256 amount);
    event Withdrawn(address indexed merchant, uint256 amount);
    event Reimbursed(address indexed merchant, address indexed relayer, uint256 amount);
    event DailyCapSet(address indexed merchant, uint256 cap);

    constructor() {
        owner = msg.sender;
    }

    /// @notice Bind the only router allowed to reimburse relayers.
    function setRouter(address router_) external {
        if (msg.sender != owner || router != address(0) || router_ == address(0)) revert NotAuthorized();
        router = router_;
    }

    /// @notice Fund a merchant's isolated WBT balance.
    function deposit(address merchant) external payable {
        if (merchant == address(0) || msg.value == 0) revert InvalidValue();
        balanceOf[merchant] += msg.value;
        emit Deposited(merchant, msg.sender, msg.value);
    }

    /// @notice Merchant sets the maximum WBT spent in a UTC day.
    function setDailyCap(uint256 cap) external {
        dailyCap[msg.sender] = cap;
        emit DailyCapSet(msg.sender, cap);
    }

    /// @notice Merchant withdraws unused WBT.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0 || amount > balanceOf[msg.sender]) revert InsufficientTank();
        balanceOf[msg.sender] -= amount;
        (bool ok,) = payable(msg.sender).call{value: amount}("");
        require(ok, "WBT transfer failed");
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Check whether a reimbursement fits the merchant balance and remaining daily cap.
    function canReimburse(address merchant, uint256 amount) public view returns (bool) {
        Daily memory d = dailySpend[merchant];
        uint256 spent = d.day == block.timestamp / 1 days ? d.spent : 0;
        return amount <= balanceOf[merchant] && dailyCap[merchant] != 0
            && amount <= dailyCap[merchant] - (spent > dailyCap[merchant] ? dailyCap[merchant] : spent);
    }

    /// @notice Router reimburses the relayer from the designated merchant only.
    function reimburse(address merchant, address payable relayer, uint256 amount) external nonReentrant {
        if (msg.sender != router) revert NotAuthorized();
        if (!canReimburse(merchant, amount)) {
            if (amount > balanceOf[merchant]) revert InsufficientTank();
            revert DailyCapExceeded();
        }
        Daily storage d = dailySpend[merchant];
        uint64 day = uint64(block.timestamp / 1 days);
        if (d.day != day) {
            d.day = day;
            d.spent = 0;
        }
        d.spent += amount;
        balanceOf[merchant] -= amount;
        (bool ok,) = relayer.call{value: amount}("");
        require(ok, "WBT transfer failed");
        emit Reimbursed(merchant, relayer, amount);
    }
}
