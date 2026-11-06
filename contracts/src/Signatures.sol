// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

/// @notice Signature checks for accounts that may carry code. An EOA delegated with EIP-7702 (as many
/// wallets now do) has code but still signs with its own key, and its delegate need not speak
/// ERC-1271. So the key's ECDSA signature is accepted first; otherwise the account's ERC-1271.
library Signatures {
    function isValid(address signer, bytes32 digest, bytes memory signature) internal view returns (bool) {
        (address recovered, ECDSA.RecoverError error,) = ECDSA.tryRecover(digest, signature);
        if (error == ECDSA.RecoverError.NoError && recovered == signer && signer != address(0)) return true;
        return signer.code.length > 0 && SignatureChecker.isValidERC1271SignatureNow(signer, digest, signature);
    }
}
