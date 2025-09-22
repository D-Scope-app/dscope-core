// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ---- IEligibilityGate ----
interface IEligibilityGate {
    function verify(address account, address survey, bytes32 nullifier, uint256 deadline, bytes calldata sig)
        external view returns (bool);
}

// ---- SurveyFlat ----
contract SurveyFlat {
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
    address public gate;
    SurveyType public surveyType;
    uint256 public startTime;
    uint256 public endTime;
    bool public finalized;

    bytes32 public metaHash;
    bytes32 public rulesHash;
    bytes32 public resultsHash;
    uint64  public claimOpenAt;
    uint64  public claimDeadline;

    Question[] public questions;
    address[] public participants;
    mapping(address => bool) public hasParticipated;
    mapping(bytes32 => bool) public nullifierUsed;

    event PrizeFunded(address indexed funder, uint256 amount);
    event PrizeSwept(address indexed to, uint256 amount);
    event SurveyCreated(address indexed survey, address indexed creator, bytes32 metaHash);
    event QuestionAdded(uint indexed index, string text);
    event Voted(address indexed voter);
    event Finalized(address indexed survey, uint256 totalParticipants, bytes32 rulesHash, bytes32 resultsHash, uint64 claimOpenAt, uint64 claimDeadline);

    modifier onlyCreator() { require(msg.sender == creator, "Only creator"); _; }
    modifier beforeStart() { require(block.timestamp < startTime, "Already started"); _; }

    constructor(SurveyType _surveyType,uint256 _startTime,uint256 _endTime,address _creator,bytes32 _metaHash,address _gate) payable {
        require(_startTime < _endTime, "Invalid time window");
        creator=_creator; gate=_gate; surveyType=_surveyType; startTime=_startTime; endTime=_endTime; metaHash=_metaHash;
        if (msg.value>0) emit PrizeFunded(_creator, msg.value);
        emit SurveyCreated(address(this), _creator, _metaHash);
    }

    function addQuestion(string calldata _text,string[] calldata _options,SelectionType _selectionType) external onlyCreator beforeStart {
        require(bytes(_text).length>0,"Empty question");
        require(_options.length>0 && _options.length<=32,"Invalid options count");
        require(questions.length<50,"Too many questions");
        Question storage q=questions.push(); q.text=_text; q.selectionType=_selectionType;
        for(uint i=0;i<_options.length;i++){ q.options.push(_options[i]); }
        emit QuestionAdded(questions.length-1,_text);
    }

    function vote(uint[][] calldata selectedOptionsPerQuestion) external {
        require(gate==address(0),"GATED_SURVEY"); _voteCommon(selectedOptionsPerQuestion);
    }

    function voteWithProof(uint[][] calldata selectedOptionsPerQuestion, bytes32 nullifier, uint256 deadline, bytes calldata sig) external {
        require(gate!=address(0),"NO_GATE"); require(!nullifierUsed[nullifier],"NullifierUsed");
        bool ok = IEligibilityGate(gate).verify(msg.sender, address(this), nullifier, deadline, sig);
        require(ok,"InvalidProof"); nullifierUsed[nullifier]=true;
        _voteCommon(selectedOptionsPerQuestion);
    }

    function _voteCommon(uint[][] calldata selectedOptionsPerQuestion) internal {
        require(block.timestamp>=startTime,"Survey not started");
        require(block.timestamp<=endTime,"Survey ended");
        require(!hasParticipated[msg.sender],"Already participated");
        require(questions.length>0,"No questions");
        require(selectedOptionsPerQuestion.length==questions.length,"Invalid number of responses");

        hasParticipated[msg.sender]=true; participants.push(msg.sender);
        for(uint i=0;i<questions.length;i++){
            Question storage q=questions[i]; uint[] calldata selections=selectedOptionsPerQuestion[i];
            if(q.selectionType==SelectionType.SINGLE){ require(selections.length==1,"Must select exactly 1 option"); }
            else { require(selections.length>0,"Must select at least 1 option"); }
            for(uint j=0;j<selections.length;j++){ uint optionIndex=selections[j]; require(optionIndex<q.options.length,"Invalid option index"); q.votesPerOption[optionIndex]++; }
            q.responses[msg.sender]=selections;
        }
        emit Voted(msg.sender);
    }

    function finalize(bytes32 _rulesHash, bytes32 _resultsHash) external { _finalizeCommon(_rulesHash,_resultsHash,0,0); }
    function finalize(bytes32 _rulesHash, bytes32 _resultsHash, uint64 _claimOpenAt, uint64 _claimDeadline) external { _finalizeCommon(_rulesHash,_resultsHash,_claimOpenAt,_claimDeadline); }

    function _finalizeCommon(bytes32 _rulesHash, bytes32 _resultsHash, uint64 _claimOpenAt, uint64 _claimDeadline) internal onlyCreator {
        require(block.timestamp>=endTime,"Survey still active"); require(!finalized,"Already finalized"); require(questions.length>0,"No questions");
        finalized=true; rulesHash=_rulesHash; resultsHash=_resultsHash; claimOpenAt=_claimOpenAt; claimDeadline=_claimDeadline;
        emit Finalized(address(this), participants.length, _rulesHash, _resultsHash, _claimOpenAt, _claimDeadline);
    }

    function prizeBalance() public view returns(uint256){ return address(this).balance; }
    function fundPrize() public payable onlyCreator { require(msg.value>0,"Zero value"); emit PrizeFunded(msg.sender,msg.value); }
    receive() external payable { fundPrize(); }
    function sweepPrize(address payable to) external onlyCreator { require(finalized,"Not finalized"); uint256 amt=address(this).balance; if(amt>0){ (bool ok,) = to.call{value:amt}(""); require(ok,"Sweep failed"); emit PrizeSwept(to,amt); } }

    function getQuestion(uint index) external view returns (string memory,string[] memory,SelectionType) { require(index<questions.length,"Invalid question index"); Question storage q=questions[index]; return (q.text,q.options,q.selectionType); }
    function getVotes(uint questionIndex) external view returns (uint[] memory){ require(questionIndex<questions.length,"Invalid question index"); Question storage q=questions[questionIndex]; uint optionCount=q.options.length; uint[] memory result=new uint[](optionCount); for(uint i=0;i<optionCount;i++){ result[i]=q.votesPerOption[i]; } return result; }
    function getParticipantResponse(address user,uint questionIndex) external view returns(uint[] memory){ require(questionIndex<questions.length,"Invalid question index"); return questions[questionIndex].responses[user]; }
    function getParticipantsCount() public view returns(uint){ return participants.length; }
    function getQuestionsCount() external view returns(uint){ return questions.length; }
}

// ---- SurveyFactoryFlat ----
contract SurveyFactoryFlat {
    event SurveyDeployed(address indexed survey,address indexed creator,uint256 startTime,uint256 endTime,SurveyFlat.SurveyType surveyType,bytes32 metaHash,uint256 plannedReward,uint256 initialValue);
    address[] public allSurveys;

    function createSurvey(SurveyFlat.SurveyType surveyType,uint256 startTime,uint256 endTime,bytes32 metaHash,uint256 plannedReward)
        external payable returns (address surveyAddr)
    {
        SurveyFlat s = new SurveyFlat{ value: msg.value }(surveyType,startTime,endTime,msg.sender,metaHash,address(0));
        surveyAddr = address(s); allSurveys.push(surveyAddr);
        emit SurveyDeployed(surveyAddr,msg.sender,startTime,endTime,surveyType,metaHash,plannedReward,msg.value);
    }

    function createSurveyWithGate(SurveyFlat.SurveyType surveyType,uint256 startTime,uint256 endTime,bytes32 metaHash,uint256 plannedReward,address gate)
        external payable returns (address surveyAddr)
    {
        require(gate!=address(0),"INVALID_GATE");
        SurveyFlat s = new SurveyFlat{ value: msg.value }(surveyType,startTime,endTime,msg.sender,metaHash,gate);
        surveyAddr = address(s); allSurveys.push(surveyAddr);
        emit SurveyDeployed(surveyAddr,msg.sender,startTime,endTime,surveyType,metaHash,plannedReward,msg.value);
    }

    function getSurveysCount() external view returns (uint256) { return allSurveys.length; }
    function getAllSurveys() external view returns (address[] memory) { return allSurveys; }
}
