// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../survey/Survey.sol";

contract SurveyFactory {
    event SurveyDeployed(
        address indexed survey,
        address indexed creator,
        uint256 startTime,
        uint256 endTime,
        Survey.SurveyType surveyType,
        bytes32 metaHash,
        uint256 plannedReward,   // off-chain budget (Safe)
        uint256 initialValue     // actual msg.value sent to Survey
    );

    address[] public allSurveys;

    /// @notice Legacy creation (no gate). Keeps the same signature for compatibility.
    function createSurvey(
        Survey.SurveyType surveyType,
        uint256 startTime,
        uint256 endTime,
        bytes32 metaHash,
        uint256 plannedReward
    ) external payable returns (address surveyAddr) {
        Survey s = new Survey{ value: msg.value }(
            surveyType,
            startTime,
            endTime,
            msg.sender,
            metaHash,
            address(0) // NO gate (legacy)
        );
        surveyAddr = address(s);
        allSurveys.push(surveyAddr);

        emit SurveyDeployed(
            surveyAddr,
            msg.sender,
            startTime,
            endTime,
            surveyType,
            metaHash,
            plannedReward,
            msg.value
        );
    }

    /// @notice New creation with gate (zkpass-lite EIP-712 attester).
    function createSurveyWithGate(
        Survey.SurveyType surveyType,
        uint256 startTime,
        uint256 endTime,
        bytes32 metaHash,
        uint256 plannedReward,
        address gate
    ) external payable returns (address surveyAddr) {
        require(gate != address(0), "INVALID_GATE");
        Survey s = new Survey{ value: msg.value }(
            surveyType,
            startTime,
            endTime,
            msg.sender,
            metaHash,
            gate
        );
        surveyAddr = address(s);
        allSurveys.push(surveyAddr);

        emit SurveyDeployed(
            surveyAddr,
            msg.sender,
            startTime,
            endTime,
            surveyType,
            metaHash,
            plannedReward,
            msg.value
        );
    }

    function getSurveysCount() external view returns (uint256) {
        return allSurveys.length;
    }

    function getAllSurveys() external view returns (address[] memory) {
        return allSurveys;
    }
}
