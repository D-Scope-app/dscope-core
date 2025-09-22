// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./IEligibilityGate.sol";

interface IERC1271 {
    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4 magicValue);
}

/// @notice Attester (EOA or contract wallet) signs typed data:
///         Eligibility(account, survey, nullifier, deadline, chainId)
contract EligibilityGateEIP712 is IEligibilityGate {
    address public owner;
    address public attester; // EOA or contract (EIP-1271)

    // EIP-712 struct hash
    // keccak256("Eligibility(address user,address survey,bytes32 nullifier,uint256 deadline,uint256 chainId)")
    bytes32 private constant ELIGIBILITY_TYPEHASH =
        0x8f6cce3b66b5e7f0c3e2a9182b0c3e6d4b2d8b36a9a9d3e2f23800d0d9d1f7e6;

    constructor(address _attester) {
        owner = msg.sender;
        attester = _attester;
    }

    function setAttester(address _attester) external {
        require(msg.sender == owner, "ONLY_OWNER");
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

    function verify(
        address account,
        address survey,
        bytes32 nullifier,
        uint256 deadline,
        bytes calldata sig
    ) external view override returns (bool) {
        if (block.timestamp > deadline) return false;

        bytes32 digest = _hashEligibility(account, survey, nullifier, deadline);

        // 1) EOA path (65-byte sig)
        if (sig.length == 65) {
            bytes32 r;
            bytes32 s;
            uint8 v;
            assembly {
                r := calldataload(sig.offset)
                s := calldataload(add(sig.offset, 32))
                v := byte(0, calldataload(add(sig.offset, 64)))
            }
            address rec = ecrecover(digest, v, r, s);
            return rec == attester;
        }

        // 2) Try 1271 path (contract-based attester)
        if (_isContract(attester)) {
            try IERC1271(attester).isValidSignature(digest, sig) returns (bytes4 magic) {
                return magic == 0x1626ba7e; // EIP-1271 magic value
            } catch {
                return false;
            }
        }

        return false;
    }

    function _isContract(address a) private view returns (bool) {
        return a.code.length > 0;
    }
}
