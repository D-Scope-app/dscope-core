// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../survey/Survey.sol";

contract SurveyFactory {
    address[] public allSurveys;
    mapping(address => address[]) public creatorToSurveys;

    event SurveyCreated(address indexed creator, address surveyAddress);

    function createSurvey(
        Survey.SurveyType _surveyType,
        string[] calldata _questionTexts,
        string[][] calldata _optionsList,
        Survey.SelectionType[] calldata _selectionTypes,
        uint _startTime,
        uint _endTime
    ) external payable returns (address) {
        Survey newSurvey = new Survey{value: msg.value}(
            _surveyType,
            _questionTexts,
            _optionsList,
            _selectionTypes,
            _startTime,
            _endTime
        );

        address surveyAddr = address(newSurvey);
        allSurveys.push(surveyAddr);
        creatorToSurveys[msg.sender].push(surveyAddr);

        emit SurveyCreated(msg.sender, surveyAddr);
        return surveyAddr;
    }

    function getAllSurveys() external view returns (address[] memory) {
        return allSurveys;
    }

    function getSurveysByCreator(address creator) external view returns (address[] memory) {
        return creatorToSurveys[creator];
    }
}
