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

    // --- Off-chain settlement anchors
    bytes32 public metaHash;
    bytes32 public rulesHash;
    bytes32 public resultsHash;
    uint64  public claimOpenAt;
    uint64  public claimDeadline;

    // --- Questions & participation
    Question[] public questions;
    address[] public participants;
    mapping(address => bool) public hasParticipated;

    // --- NEW: prize-pool events
    event PrizeFunded(address indexed from, uint256 amount);
    event PrizeSwept(address indexed to, uint256 amount);

    // --- Events (existing)
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

    modifier onlyCreator() {
        require(msg.sender == creator, "Only creator");
        _;
    }
    modifier beforeStart() {
        require(block.timestamp < startTime, "Already started");
        _;
    }

    // NOTE: constructor is now payable to accept optional initial prize funding (B2).
    constructor(
        SurveyType _surveyType,
        uint256 _startTime,
        uint256 _endTime,
        address _creator,
        bytes32 _metaHash
    ) payable {
        require(_startTime < _endTime, "Invalid time window");
        creator = _creator;
        surveyType = _surveyType;
        startTime = _startTime;
        endTime = _endTime;
        metaHash = _metaHash;

        // Emit funded event if value was sent during deployment via Factory{value: ...}
        if (msg.value > 0) {
            emit PrizeFunded(_creator, msg.value);
        }

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

            q.responses[msg.sender] = selections;
        }

        emit Voted(msg.sender);
    }

    // ===== Finalization =====

    function finalize(bytes32 _rulesHash, bytes32 _resultsHash) external {
        _finalizeCommon(_rulesHash, _resultsHash, 0, 0);
    }

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

        emit Finalized(address(this), participants.length, _rulesHash, _resultsHash, _claimOpenAt, _claimDeadline);
    }

    // ===== NEW: Prize pool helpers =====

    /// @notice Current prize balance (native ETH on zkSync)
    function prizeBalance() public view returns (uint256) {
        return address(this).balance;
    }

    /// @notice Allow the creator to top-up the prize pool after deployment (optional).
    /// If later you want public funding, remove the onlyCreator check or gate it by a flag.
    function fundPrize() public payable onlyCreator {
        require(msg.value > 0, "Zero value");
        emit PrizeFunded(msg.sender, msg.value);
    }

    /// @notice Accept plain ETH transfers; by default restrict to creator via fundPrize.
    receive() external payable {
        // Route to fundPrize to reuse checks and event
        // If you want to allow anyone to fund, replace with:
        // require(msg.value > 0, "Zero value"); emit PrizeFunded(msg.sender, msg.value);
        fundPrize();
    }

    /// @notice Sweep remaining prize (e.g., to a payout module or back to the creator) after finalize.
    function sweepPrize(address payable to) external onlyCreator {
        require(finalized, "Not finalized");
        uint256 amt = address(this).balance;
        if (amt > 0) {
            (bool ok, ) = to.call{value: amt}("");
            require(ok, "Sweep failed");
            emit PrizeSwept(to, amt);
        }
    }

    // ===== Views =====

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
