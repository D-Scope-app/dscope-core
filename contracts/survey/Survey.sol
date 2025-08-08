// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Survey {
    enum SurveyType { MULTIPLE_CHOICE, BINARY_VOTE }
    enum SelectionType { SINGLE, MULTIPLE }

    struct Question {
        string text;
        string[] options;
        SelectionType selectionType;
        mapping(address => uint[]) responses;       
        mapping(uint => uint) votesPerOption;       
    }

    address public creator;
    SurveyType public surveyType;
    uint public startTime;
    uint public endTime;
    bool public finalized;

    Question[] public questions;
    address[] public participants;
    mapping(address => bool) public hasParticipated;

    uint public rewardPool;
    uint public rewardPerParticipant;

    event Voted(address indexed voter);
    event Finalized(uint totalParticipants, uint rewardPerParticipant);
    event Claimed(address indexed voter, uint amount);
    event Refunded(address indexed creator, uint amount);

    constructor(
        SurveyType _surveyType,
        string[] memory _questionTexts,
        string[][] memory _optionsList,
        SelectionType[] memory _selectionTypes,
        uint _startTime,
        uint _endTime
    ) payable {
        require(_questionTexts.length == _optionsList.length, "Mismatch in questions/options");
        require(_questionTexts.length == _selectionTypes.length, "Mismatch in selectionTypes");
        require(_startTime < _endTime, "Invalid time window");
        require(_questionTexts.length > 0 && _questionTexts.length <= 10, "Invalid number of questions");

        creator = msg.sender;
        surveyType = _surveyType;
        startTime = _startTime;
        endTime = _endTime;
        rewardPool = msg.value;

        for (uint i = 0; i < _questionTexts.length; i++) {
            Question storage q = questions.push();
            q.text = _questionTexts[i];
            q.options = _optionsList[i];
            q.selectionType = _selectionTypes[i];
        }
    }

    function vote(uint[][] calldata selectedOptionsPerQuestion) external {
        require(block.timestamp >= startTime, "Survey not started");
        require(block.timestamp <= endTime, "Survey ended");
        require(!hasParticipated[msg.sender], "Already participated");
        require(selectedOptionsPerQuestion.length == questions.length, "Invalid number of responses");

        hasParticipated[msg.sender] = true;
        participants.push(msg.sender);

        for (uint i = 0; i < questions.length; i++) {
            Question storage q = questions[i];
            uint[] calldata selections = selectedOptionsPerQuestion[i];

            if (q.selectionType == SelectionType.SINGLE) {
                require(selections.length == 1, "Must select exactly 1 option");
            } else {
                require(selections.length > 0, "Must select at least 1 option");
            }

            for (uint j = 0; j < selections.length; j++) {
                uint optionIndex = selections[j];
                require(optionIndex < q.options.length, "Invalid option index");
                q.votesPerOption[optionIndex]++;
            }

            q.responses[msg.sender] = selections;
        }

        emit Voted(msg.sender);
    }

    function finalize() external {
        require(block.timestamp > endTime, "Survey still active");
        require(!finalized, "Already finalized");

        finalized = true;

        uint totalParticipants = participants.length;
        if (totalParticipants > 0) {
            rewardPerParticipant = rewardPool / totalParticipants;
        }

        emit Finalized(totalParticipants, rewardPerParticipant);
    }

    function claimReward() external {
        require(finalized, "Survey not finalized");
        require(hasParticipated[msg.sender], "Not a participant");
        require(rewardPerParticipant > 0, "No rewards available");

        hasParticipated[msg.sender] = false;
        rewardPool -= rewardPerParticipant;

        (bool success, ) = payable(msg.sender).call{value: rewardPerParticipant}("");
        require(success, "Transfer failed");

        emit Claimed(msg.sender, rewardPerParticipant);
    }

    function refundCreator() external {
        require(finalized, "Survey not finalized");
        require(participants.length == 0, "Participants exist");
        require(msg.sender == creator, "Only creator");

        uint amount = rewardPool;
        rewardPool = 0;

        (bool success, ) = payable(creator).call{value: amount}("");
        require(success, "Refund failed");

        emit Refunded(creator, amount);
    }

    // ========== View Functions ==========

    function getQuestion(uint index) external view returns (
        string memory text,
        string[] memory options,
        SelectionType selectionType
    ) {
        require(index < questions.length, "Invalid question index");
        Question storage q = questions[index];
        return (q.text, q.options, q.selectionType);
    }

    function getVotes(uint questionIndex) external view returns (uint[] memory) {
        require(questionIndex < questions.length, "Invalid question index");
        Question storage q = questions[questionIndex];
        uint optionCount = q.options.length;

        uint[] memory result = new uint[](optionCount);
        for (uint i = 0; i < optionCount; i++) {
            result[i] = q.votesPerOption[i];
        }
        return result;
    }

    function getParticipantResponse(address user, uint questionIndex) external view returns (uint[] memory) {
        require(questionIndex < questions.length, "Invalid question index");
        return questions[questionIndex].responses[user];
    }

    // ========== Receive Fallback ==========

    receive() external payable {
        rewardPool += msg.value;
    }
}
