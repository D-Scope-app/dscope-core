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
        uint256 plannedReward,   // офчейн бюджет (Safe)
        uint256 initialValue     // фактический msg.value, ушедший в Survey
    );

    address[] public allSurveys;

    function createSurvey(
        Survey.SurveyType surveyType,
        uint256 startTime,
        uint256 endTime,
        bytes32 metaHash,        // ВАЖНО: теперь bytes32, без keccak внутри
        uint256 plannedReward    // заявка на офчейн-пул (может быть 0)
    ) external payable returns (address surveyAddr) {
        Survey s = new Survey{ value: msg.value }(
            surveyType,
            startTime,
            endTime,
            msg.sender,
            metaHash
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
