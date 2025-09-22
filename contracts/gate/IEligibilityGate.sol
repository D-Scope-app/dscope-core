// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IEligibilityGate {
    function verify(
        address account,
        address survey,
        bytes32 nullifier,
        uint256 deadline,
        bytes calldata sig
    ) external view returns (bool);
}
