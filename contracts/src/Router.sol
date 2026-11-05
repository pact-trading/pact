// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {GasTank} from "./GasTank.sol";

interface ISponsoredTarget {
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount);
}

/// @notice Executes signed, allowlisted calls and reimburses the submitting relayer from one merchant tank.
contract Router is ReentrancyGuard {
    using SafeERC20 for IERC20;
    error NotOwner();
    error InvalidConfig();
    error InsufficientExecutionGas();
    enum Refusal {
        InvalidSignature,
        Deadline,
        Replay,
        WrongSelector,
        QuoteMismatch,
        Dust,
        PayerDailyCap,
        GasLimit,
        GasPrice,
        FeeTooLow,
        TankLimit,
        FeeUnavailable,
        TargetFailed,
        TargetRefused
    }

    struct Intent {
        address signer;
        address merchant;
        address target;
        bytes32 dataHash;
        uint256 amount;
        uint256 feeUSDT;
        uint256 nonce;
        uint64 deadline;
        uint32 maxGas;
    }

    struct Allowed {
        bool enabled;
        bool mustReturnTrue;
    }

    struct Daily {
        uint64 day;
        uint32 count;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 feeUSDT,uint256 nonce,uint64 deadline,uint32 maxGas)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    uint256 private constant REIMBURSEMENT_OVERHEAD = 40_000;
    uint256 private constant EXECUTION_GAS_RESERVE = 120_000;

    address public owner;
    address public feeVault;
    IERC20 public immutable usdt;
    GasTank public immutable gasTank;
    address public activeSigner;
    address public activeMerchant;
    uint256 public minAmount;
    uint256 public usdtPerWBT;
    uint32 public maxPayerCallsPerDay;
    uint32 public maxGasPerCall;
    uint256 public maxGasPrice;
    mapping(address => mapping(bytes4 => Allowed)) public allowed;
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    mapping(address => Daily) public payerDaily;
    event Refused(address indexed signer, address indexed merchant, uint256 indexed nonce, Refusal reason);
    event Executed(
        address indexed signer,
        address indexed merchant,
        uint256 indexed nonce,
        address target,
        uint256 reimbursement,
        uint256 feeUSDT
    );
    event AllowedSet(address indexed target, bytes4 indexed selector, bool enabled, bool mustReturnTrue);

    constructor(IERC20 usdt_, GasTank tank_, address feeVault_) {
        if (address(usdt_) == address(0) || address(tank_) == address(0) || feeVault_ == address(0)) {
            revert InvalidConfig();
        }
        owner = msg.sender;
        usdt = usdt_;
        gasTank = tank_;
        feeVault = feeVault_;
        minAmount = 1_000_000; // 1 USDT at six decimals
        usdtPerWBT = 1_000_000; // configurable quote: 1 USDT per WBT
        maxPayerCallsPerDay = 10;
        maxGasPerCall = 1_000_000;
        maxGasPrice = 100 gwei;
    }

    /// @notice Set a precise target and selector allowlist entry.
    function setAllowed(address target, bytes4 selector, bool enabled, bool mustReturnTrue) external {
        if (msg.sender != owner) revert NotOwner();
        if (target.code.length == 0) revert InvalidConfig();
        allowed[target][selector] = Allowed(enabled, mustReturnTrue);
        emit AllowedSet(target, selector, enabled, mustReturnTrue);
    }

    /// @notice Set global sponsorship limits and the USDT per WBT conversion quote.
    function setLimits(
        uint256 minAmount_,
        uint256 usdtPerWBT_,
        uint32 payerDailyCap_,
        uint32 maxGas_,
        uint256 maxGasPrice_
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (minAmount_ == 0 || usdtPerWBT_ == 0 || payerDailyCap_ == 0 || maxGas_ == 0 || maxGasPrice_ == 0) {
            revert InvalidConfig();
        }
        minAmount = minAmount_;
        usdtPerWBT = usdtPerWBT_;
        maxPayerCallsPerDay = payerDailyCap_;
        maxGasPerCall = maxGas_;
        maxGasPrice = maxGasPrice_;
    }

    /// @notice EIP-712 domain separator for sponsored intents.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Settle Router")), keccak256(bytes("1")), block.chainid, address(this)
            )
        );
    }

    /// @notice Hash an intent for EIP-712 signing.
    function hashIntent(Intent calldata i) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                i.signer,
                i.merchant,
                i.target,
                i.dataHash,
                i.amount,
                i.feeUSDT,
                i.nonce,
                i.deadline,
                i.maxGas
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Validate a signed call, execute it, collect a real USDT fee, and reimburse the relayer in WBT.
    function execute(Intent calldata i, bytes calldata data, bytes calldata signature)
        external
        nonReentrant
        returns (bool, bytes memory)
    {
        uint256 gasStart = gasleft();
        (address recovered, ECDSA.RecoverError sigError,) = ECDSA.tryRecover(hashIntent(i), signature);
        if (sigError != ECDSA.RecoverError.NoError || recovered != i.signer || i.signer == address(0)) {
            return _refuse(i, Refusal.InvalidSignature);
        }
        if (block.timestamp > i.deadline) return _refuse(i, Refusal.Deadline);
        if (usedNonces[i.signer][i.nonce]) return _refuse(i, Refusal.Replay);
        if (data.length < 4 || keccak256(data) != i.dataHash || !allowed[i.target][bytes4(data[:4])].enabled) {
            return _refuse(i, Refusal.WrongSelector);
        }
        if (i.maxGas == 0 || i.maxGas > maxGasPerCall || gasleft() <= uint256(i.maxGas) + 80_000) {
            return _refuse(i, Refusal.GasLimit);
        }
        if (tx.gasprice > maxGasPrice) return _refuse(i, Refusal.GasPrice);
        try ISponsoredTarget(i.target).sponsorshipQuote(data) returns (address merchant, uint256 amount) {
            if (merchant != i.merchant || amount != i.amount || merchant == address(0)) {
                return _refuse(i, Refusal.QuoteMismatch);
            }
        } catch {
            return _refuse(i, Refusal.QuoteMismatch);
        }
        if (i.amount < minAmount) return _refuse(i, Refusal.Dust);
        Daily storage daily = payerDaily[i.signer];
        uint64 day = uint64(block.timestamp / 1 days);
        if (daily.day == day && daily.count >= maxPayerCallsPerDay) return _refuse(i, Refusal.PayerDailyCap);
        uint256 maxCost = (uint256(i.maxGas) + REIMBURSEMENT_OVERHEAD) * tx.gasprice;
        if (i.feeUSDT < _feeFor(maxCost)) return _refuse(i, Refusal.FeeTooLow);
        if (!gasTank.canReimburse(i.merchant, maxCost)) return _refuse(i, Refusal.TankLimit);
        if (usdt.balanceOf(i.merchant) < i.feeUSDT || usdt.allowance(i.merchant, address(this)) < i.feeUSDT) {
            return _refuse(i, Refusal.FeeUnavailable);
        }

        usedNonces[i.signer][i.nonce] = true;
        if (daily.day != day) {
            daily.day = day;
            daily.count = 0;
        }
        daily.count++;
        activeSigner = i.signer;
        activeMerchant = i.merchant;
        bytes memory callData = data;
        // The early policy check precedes external reads and storage writes. Recheck here
        // so EIP-150 cannot clip the signed target allowance and consume a nonce on failure.
        // Keep gas for settlement as well; revert rolls back the nonce, count and context.
        uint256 targetGas = uint256(i.maxGas);
        if (gasleft() <= targetGas + targetGas / 63 + EXECUTION_GAS_RESERVE) {
            revert InsufficientExecutionGas();
        }
        (bool ok, bytes memory result) = i.target.call{gas: targetGas}(callData);
        activeSigner = address(0);
        activeMerchant = address(0);
        if (!ok) return _refuse(i, Refusal.TargetFailed);
        if (allowed[i.target][bytes4(data[:4])].mustReturnTrue && (result.length != 32 || !abi.decode(result, (bool))))
        {
            return _refuse(i, Refusal.TargetRefused);
        }
        uint256 reimbursement = (gasStart - gasleft() + REIMBURSEMENT_OVERHEAD) * tx.gasprice;
        // Router overhead is metered too, so measured gas can exceed the target allowance.
        // Never debit more than the budget checked against the signed fee and merchant tank.
        if (reimbursement > maxCost) reimbursement = maxCost;
        if (!gasTank.canReimburse(i.merchant, reimbursement)) revert GasTank.DailyCapExceeded();
        usdt.safeTransferFrom(i.merchant, feeVault, i.feeUSDT);
        gasTank.reimburse(i.merchant, payable(msg.sender), reimbursement);
        emit Executed(i.signer, i.merchant, i.nonce, i.target, reimbursement, i.feeUSDT);
        return (true, result);
    }

    function _feeFor(uint256 wbtWei) internal view returns (uint256) {
        return (wbtWei * usdtPerWBT + 1e18 - 1) / 1e18;
    }

    function _refuse(Intent calldata i, Refusal reason) internal returns (bool, bytes memory) {
        emit Refused(i.signer, i.merchant, i.nonce, reason);
        return (false, "");
    }
}
