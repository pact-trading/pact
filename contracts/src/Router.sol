// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IFeeSchedule} from "./FeeSchedule.sol";

interface ISponsoredTarget {
    function sponsorshipQuote(bytes calldata data) external view returns (address merchant, uint256 amount);
}

/// @notice Executes signed, allowlisted calls that Pact's relayer pays the gas for.
/// @dev Pact's fee is not taken here. A payment target takes it out of the money it moves, under the
/// terms the merchant accepted in the FeeSchedule. The Router only charges gas, in USDT, on calls
/// allowlisted with `chargesGas`: calls where the merchant sends money (a refund, a buy-back) and so
/// pays their gas on top. Those calls must be signed by the merchant itself.
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
        FeeUnavailable,
        TargetFailed,
        TargetRefused,
        SignerNotMerchant
    }

    struct Intent {
        address signer;
        address merchant;
        address target;
        bytes32 dataHash;
        uint256 amount;
        uint256 nonce;
        uint64 deadline;
        uint32 maxGas;
    }

    struct Allowed {
        bool enabled;
        bool mustReturnTrue;
        /// The merchant signs, sends money in the call, and pays its gas in USDT on top.
        bool chargesGas;
        /// The amount must reach the minimum. Off for calls that only close or release money.
        bool checksAmount;
    }

    struct Daily {
        uint64 day;
        uint32 count;
    }

    bytes32 public constant INTENT_TYPEHASH = keccak256(
        "Intent(address signer,address merchant,address target,bytes32 dataHash,uint256 amount,uint256 nonce,uint64 deadline,uint32 maxGas)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    /// @dev Gas the measurement cannot see: the transaction's intrinsic and calldata cost, and the fee transfer.
    uint256 public constant GAS_OVERHEAD = 60_000;
    uint256 private constant EXECUTION_GAS_RESERVE = 120_000;

    address public owner;
    IERC20 public immutable usdt;
    IFeeSchedule public immutable fees;
    address public activeSigner;
    address public activeMerchant;
    uint256 public minAmount;
    uint32 public maxPayerCallsPerDay;
    uint32 public maxGasPerCall;
    uint256 public maxGasPrice;
    mapping(address => mapping(bytes4 => Allowed)) public allowed;
    mapping(address => mapping(uint256 => bool)) public usedNonces;
    mapping(address => Daily) public payerDaily;

    event Refused(address indexed signer, address indexed merchant, uint256 indexed nonce, Refusal reason);
    event Executed(
        address indexed signer, address indexed merchant, uint256 indexed nonce, address target, uint256 gasFee
    );
    event AllowedSet(
        address indexed target,
        bytes4 indexed selector,
        bool enabled,
        bool mustReturnTrue,
        bool chargesGas,
        bool checksAmount
    );
    event LimitsSet(uint256 minAmount, uint32 payerDailyCap, uint32 maxGas, uint256 maxGasPrice);

    constructor(IERC20 usdt_, IFeeSchedule fees_) {
        if (address(usdt_) == address(0) || address(fees_) == address(0)) revert InvalidConfig();
        owner = msg.sender;
        usdt = usdt_;
        fees = fees_;
        minAmount = 1_000_000; // 1 USDT at six decimals
        maxPayerCallsPerDay = 10;
        maxGasPerCall = 1_000_000;
        maxGasPrice = 100 gwei;
    }

    /// @notice Set a precise target and selector allowlist entry.
    function setAllowed(
        address target,
        bytes4 selector,
        bool enabled,
        bool mustReturnTrue,
        bool chargesGas,
        bool checksAmount
    ) external {
        if (msg.sender != owner) revert NotOwner();
        if (target.code.length == 0) revert InvalidConfig();
        allowed[target][selector] = Allowed(enabled, mustReturnTrue, chargesGas, checksAmount);
        emit AllowedSet(target, selector, enabled, mustReturnTrue, chargesGas, checksAmount);
    }

    /// @notice Set global sponsorship limits.
    function setLimits(uint256 minAmount_, uint32 payerDailyCap_, uint32 maxGas_, uint256 maxGasPrice_) external {
        if (msg.sender != owner) revert NotOwner();
        if (minAmount_ == 0 || payerDailyCap_ == 0 || maxGas_ == 0 || maxGasPrice_ == 0) revert InvalidConfig();
        minAmount = minAmount_;
        maxPayerCallsPerDay = payerDailyCap_;
        maxGasPerCall = maxGas_;
        maxGasPrice = maxGasPrice_;
        emit LimitsSet(minAmount_, payerDailyCap_, maxGas_, maxGasPrice_);
    }

    /// @notice EIP-712 domain separator for sponsored intents.
    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256(bytes("Settle Router")), keccak256(bytes("2")), block.chainid, address(this)
            )
        );
    }

    /// @notice Hash an intent for EIP-712 signing.
    function hashIntent(Intent calldata i) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH, i.signer, i.merchant, i.target, i.dataHash, i.amount, i.nonce, i.deadline, i.maxGas
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice The most gas, in USDT, a `chargesGas` call with this intent can cost the merchant.
    function maxGasFee(uint32 maxGas, uint256 gasPrice) public view returns (uint256) {
        return fees.gasFee((uint256(maxGas) + GAS_OVERHEAD) * gasPrice);
    }

    /// @notice Validate a signed call and execute it. Refusals return false and emit the reason.
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
        if (data.length < 4 || keccak256(data) != i.dataHash) return _refuse(i, Refusal.WrongSelector);
        Allowed memory rule = allowed[i.target][bytes4(data[:4])];
        if (!rule.enabled) return _refuse(i, Refusal.WrongSelector);
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
        if (rule.checksAmount && i.amount < minAmount) return _refuse(i, Refusal.Dust);
        Daily storage daily = payerDaily[i.signer];
        uint64 day = uint64(block.timestamp / 1 days);
        if (daily.day == day && daily.count >= maxPayerCallsPerDay) return _refuse(i, Refusal.PayerDailyCap);
        if (rule.chargesGas) {
            if (i.signer != i.merchant) return _refuse(i, Refusal.SignerNotMerchant);
            // The merchant sends `amount` in the call and its gas after it: both must be there.
            uint256 ceiling = maxGasFee(i.maxGas, tx.gasprice);
            if (usdt.balanceOf(i.merchant) < i.amount + ceiling || usdt.allowance(i.merchant, address(this)) < ceiling) return _refuse(
                i, Refusal.FeeUnavailable
            );
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
        if (rule.mustReturnTrue && (result.length != 32 || !abi.decode(result, (bool)))) {
            return _refuse(i, Refusal.TargetRefused);
        }
        uint256 gasFee;
        if (rule.chargesGas) {
            uint256 used = gasStart - gasleft() + GAS_OVERHEAD;
            uint256 cap = targetGas + GAS_OVERHEAD;
            // Router overhead is metered too; never charge more than the ceiling checked above.
            gasFee = fees.gasFee((used > cap ? cap : used) * tx.gasprice);
            if (gasFee > 0) usdt.safeTransferFrom(i.merchant, fees.recipient(), gasFee);
        }
        emit Executed(i.signer, i.merchant, i.nonce, i.target, gasFee);
        return (true, result);
    }

    function _refuse(Intent calldata i, Refusal reason) internal returns (bool, bytes memory) {
        emit Refused(i.signer, i.merchant, i.nonce, reason);
        return (false, "");
    }
}
