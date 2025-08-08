// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Survey {
    address public creator;
    string public question;
    string[] public options;
    uint public startTime;
    uint public endTime;
    uint public totalVotes;
    uint public rewardPool;
    bool public finalized;
    uint public rewardPerVoter;

    mapping(address => bool) public hasVoted;
    mapping(uint => uint) public votes;
    address[] public voters;

    event Voted(address indexed voter, uint indexed option);
    event Finalized(uint totalVotes, uint rewardPerVoter);
    event Claimed(address indexed voter, uint amount);
    event Refunded(address indexed creator, uint amount);

    constructor(
    string memory _question,
    string[] memory _options,
    uint _startTime,
    uint _endTime
) payable {
    require(_options.length >= 2, "Need at least 2 options");
    require(_startTime < _endTime, "Invalid time window");

    creator = msg.sender;
    question = _question;
    options = _options;
    startTime = _startTime;
    endTime = _endTime;
    rewardPool = msg.value; 
}


    function getOptions() external view returns (string[] memory) {
        return options;
    }

    function vote(uint optionIndex) external {
        require(block.timestamp >= startTime, "Voting has not started");
        require(block.timestamp <= endTime, "Voting has ended");
        require(!hasVoted[msg.sender], "Already voted");
        require(optionIndex < options.length, "Invalid option");

        hasVoted[msg.sender] = true;
        votes[optionIndex]++;
        totalVotes++;
        voters.push(msg.sender);

        emit Voted(msg.sender, optionIndex);
    }

    function finalize() external {
        require(block.timestamp > endTime, "Voting is still active");
        require(!finalized, "Already finalized");

        finalized = true;

        if (totalVotes > 0) {
            rewardPerVoter = rewardPool / totalVotes;
        }

        emit Finalized(totalVotes, rewardPerVoter);
    }

    function claimReward() external {
        require(finalized, "Survey not finalized");
        require(hasVoted[msg.sender], "Not a participant");

        uint amount = rewardPerVoter;
        require(amount > 0, "No reward available");

        hasVoted[msg.sender] = false;
        rewardPool -= amount;

        (bool success, ) = payable(msg.sender).call{value: amount}("");
        require(success, "Transfer failed");

        emit Claimed(msg.sender, amount);
    }

    function refundCreator() external {
        require(finalized, "Survey not finalized");
        require(totalVotes == 0, "Votes exist");
        require(msg.sender == creator, "Not creator");

        uint amount = rewardPool;
        rewardPool = 0;

        (bool success, ) = payable(creator).call{value: amount}("");
        require(success, "Refund failed");

        emit Refunded(creator, amount);
    }

    receive() external payable {
        rewardPool += msg.value;
    }
}
