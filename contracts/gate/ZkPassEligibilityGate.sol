// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Proof} from "../Common.sol";
import {ProofVerifier} from "../ProofVerifier.sol";

contract ZkPassEligibilityGate is ProofVerifier {
    mapping(address user => mapping(address survey => bool)) public isEligible;

    // Optional: защита от replay (рекомендуется для production)
    mapping(bytes32 => bool) public usedUHash;

    event EligibilityAttested(address indexed user, address indexed survey, bytes32 indexed uHash);

    /**
     * @notice Verify full zkPass Proof and grant eligibility
     * @param proof The entire Proof struct from zkPass SDK (converted to bytes32)
     * @param survey The survey address for which eligibility is granted
     */
    function attest(Proof calldata proof, address survey) external {
        require(proof.recipient == msg.sender, "Recipient must be caller");
        require(verify(proof), "Invalid proof");

        // DEMO MODE: allow same uHash across different surveys
// In production this MUST be enabled
// require(!usedUHash[proof.uHash], "uHash already used");

        usedUHash[proof.uHash] = true;

        isEligible[msg.sender][survey] = true;
        emit EligibilityAttested(msg.sender, survey, proof.uHash);
    }

    function checkEligibility(address user, address survey) external view returns (bool) {
        return isEligible[user][survey];
    }
}
