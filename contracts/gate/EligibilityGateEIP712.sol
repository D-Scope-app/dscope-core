// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IEligibilityGate.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4);
}

/// @notice Attester (EOA or contract wallet) signs typed data:
///         Eligibility(address user,address survey,bytes32 nullifier,uint256 deadline,uint256 chainId)
contract EligibilityGateEIP712 is IEligibilityGate {
    address public owner;
    address public attester; // EOA or contract (EIP-1271)

    event AttesterChanged(address indexed previousAttester, address indexed newAttester);

    // keccak256("Eligibility(address user,address survey,bytes32 nullifier,uint256 deadline,uint256 chainId)")
    bytes32 private constant ELIGIBILITY_TYPEHASH =
        keccak256("Eligibility(address user,address survey,bytes32 nullifier,uint256 deadline,uint256 chainId)");

    constructor(address _attester) {
        require(_attester != address(0), "ATT_ZERO");
        owner = msg.sender;
        attester = _attester;
        emit AttesterChanged(address(0), _attester);
    }

    function setAttester(address _attester) external {
        require(msg.sender == owner, "ONLY_OWNER");
        require(_attester != address(0), "ATT_ZERO");
        emit AttesterChanged(attester, _attester);
        attester = _attester;
    }

    function _domainSeparator() internal view returns (bytes32) {
        // EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes("DScopeEligibility")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashEligibility(
        address user,
        address survey,
        bytes32 nullifier,
        uint256 deadline
    ) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(ELIGIBILITY_TYPEHASH, user, survey, nullifier, deadline, block.chainid)
        );
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// @dev external pure обёртка, чтобы можно было ловить revert из ECDSA.recover через try/catch
    function _recoverExt(bytes32 digest, bytes calldata sig) external pure returns (address) {
        // OpenZeppelin ECDSA.recover поддерживает и 65-байт, и 64-байт (EIP-2098) подписи.
        return ECDSA.recover(digest, sig);
    }

    function verify(
        address account,
        address survey,
        bytes32 nullifier,
        uint256 deadline,
        bytes calldata sig
    ) external view override returns (bool) {
        if (block.timestamp > deadline) return false;

        bytes32 digest = _hashEligibility(account, survey, nullifier, deadline);

        // 1) Если attester — контракт, сначала пробуем EIP-1271 (даже для 65-байтовых сигнатур)
        if (_isContract(attester)) {
            try IERC1271(attester).isValidSignature(digest, sig) returns (bytes4 magic) {
                if (magic == 0x1626ba7e) return true;
            } catch {
                // продолжим EOA-путь
            }
        }

        // 2) EOA-путь: используем recover с try/catch через внешнюю обёртку,
        //    чтобы не ронять вызов при некорректной подписи/длине.
        {
            // сигнатура должна быть 64 или 65 байт — иначе даже не пытаемся
            if (sig.length != 64 && sig.length != 65) return false;

            address recovered;
            try this._recoverExt(digest, sig) returns (address rec) {
                recovered = rec;
            } catch {
                return false;
            }

            if (recovered == attester) return true;
        }

        return false;
    }

    function _isContract(address a) private view returns (bool) {
        return a.code.length > 0;
    }
}
