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
        bytes32 metaHash // <- bytes32 в ивенте
    );

    address[] public allSurveys;

    function createSurvey(
        Survey.SurveyType surveyType,
        uint256 startTime,
        uint256 endTime,
        string calldata metaHash // принимаем строку (например, ipfs://CID)
    ) external returns (address surveyAddr) {
        // приводим к bytes32 через keccak256
        bytes32 metaHash32 = keccak256(bytes(metaHash));

        Survey s = new Survey(
            surveyType,
            startTime,
            endTime,
            msg.sender,
            metaHash32
        );
        surveyAddr = address(s);

        allSurveys.push(surveyAddr);
        emit SurveyDeployed(surveyAddr, msg.sender, startTime, endTime, surveyType, metaHash32);
    }

    function getSurveysCount() external view returns (uint256) {
        return allSurveys.length;
    }

    function getAllSurveys() external view returns (address[] memory) {
        return allSurveys;
    }
}
