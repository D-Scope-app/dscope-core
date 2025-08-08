// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "../survey/Survey.sol";

contract SurveyFactory {
    event SurveyCreated(address indexed creator, address surveyAddress);

    function createSurvey(
        string memory _question,
        string[] memory _options,
        uint _startTime,
        uint _endTime
    ) external payable returns (address) {
        Survey newSurvey = new Survey{value: msg.value}(
            _question,
            _options,
            _startTime,
            _endTime
        );

        emit SurveyCreated(msg.sender, address(newSurvey));
        return address(newSurvey);
    }
}
