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

    // --- Core metadata/state
    address public creator;
    SurveyType public surveyType;
    uint256 public startTime;
    uint256 public endTime;
    bool public finalized;

    // --- Off-chain settlement anchors (for indexer & payouts)
    bytes32 public metaHash;      // hash of public survey metadata (IPFS/GitHub JSON)
    bytes32 public rulesHash;     // hash of reward rules JSON used for accruals
    bytes32 public resultsHash;   // hash of aggregated results snapshot
    uint64  public claimOpenAt;   // informational: when off-chain claims can start
    uint64  public claimDeadline; // informational: when off-chain claims should end

    // --- Questions & participation
    Question[] public questions;
    address[] public participants;
    mapping(address => bool) public hasParticipated;

    // --- Events
    event SurveyCreated(address indexed survey, address indexed creator, bytes32 metaHash);
    event QuestionAdded(uint indexed index, string text);
    event Voted(address indexed voter);
    event Finalized(
        address indexed survey,
        uint256 totalParticipants,
        bytes32 rulesHash,
        bytes32 resultsHash,
        uint64 claimOpenAt,
        uint64 claimDeadline
    );

    // --- Modifiers
    modifier onlyCreator() {
        require(msg.sender == creator, "Only creator");
        _;
    }

    modifier beforeStart() {
        require(block.timestamp < startTime, "Already started");
        _;
    }

    constructor(
        SurveyType _surveyType,
        uint256 _startTime,
        uint256 _endTime,
        address _creator,
        bytes32 _metaHash
    ) {
        require(_startTime < _endTime, "Invalid time window");
        creator = _creator;
        surveyType = _surveyType;
        startTime = _startTime;
        endTime = _endTime;
        metaHash = _metaHash;

        emit SurveyCreated(address(this), _creator, _metaHash);
    }

    /// @notice Add a question before the survey starts
    function addQuestion(
        string calldata _text,
        string[] calldata _options,
        SelectionType _selectionType
    ) external onlyCreator beforeStart {
        require(bytes(_text).length > 0, "Empty question");
        require(_options.length > 0 && _options.length <= 32, "Invalid options count");
        require(questions.length < 50, "Too many questions");

        Question storage q = questions.push();
        q.text = _text;
        q.selectionType = _selectionType;
        for (uint i = 0; i < _options.length; i++) {
            q.options.push(_options[i]);
        }

        emit QuestionAdded(questions.length - 1, _text);
    }

    function vote(uint[][] calldata selectedOptionsPerQuestion) external {
        require(block.timestamp >= startTime, "Survey not started");
        require(block.timestamp <= endTime, "Survey ended");
        require(!hasParticipated[msg.sender], "Already participated");
        require(questions.length > 0, "No questions");
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

            // Persist user's selections for this question
            q.responses[msg.sender] = selections;
        }

        emit Voted(msg.sender);
    }

    // ===== Finalization =====

    /// @notice Finalize with default (informational) claim window = 0/0
    function finalize(bytes32 _rulesHash, bytes32 _resultsHash) external {
        _finalizeCommon(_rulesHash, _resultsHash, 0, 0);
    }

    /// @notice Finalize with explicit (informational) claim window
    function finalize(
        bytes32 _rulesHash,
        bytes32 _resultsHash,
        uint64 _claimOpenAt,
        uint64 _claimDeadline
    ) external {
        _finalizeCommon(_rulesHash, _resultsHash, _claimOpenAt, _claimDeadline);
    }

    function _finalizeCommon(
        bytes32 _rulesHash,
        bytes32 _resultsHash,
        uint64 _claimOpenAt,
        uint64 _claimDeadline
    ) internal onlyCreator {
        require(block.timestamp >= endTime, "Survey still active");
        require(!finalized, "Already finalized");
        require(questions.length > 0, "No questions");

        finalized = true;

        rulesHash = _rulesHash;
        resultsHash = _resultsHash;
        claimOpenAt = _claimOpenAt;
        claimDeadline = _claimDeadline;

        emit Finalized(
            address(this),
            participants.length,
            _rulesHash,
            _resultsHash,
            _claimOpenAt,
            _claimDeadline
        );
    }

    // ===== View helpers =====

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

    function getParticipantsCount() public view returns (uint) {
        return participants.length;
    }

    function getQuestionsCount() external view returns (uint) {
        return questions.length;
    }
}
