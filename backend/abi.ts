// backend/abi.ts
export const SURVEY_FACTORY_ABI = [
  "event SurveyDeployed(address indexed survey, address indexed creator, uint256 startTime, uint256 endTime, uint8 surveyType, bytes32 metaHash, uint256 plannedReward, uint256 initialValue)",
] as const;

export const SURVEY_ABI = [
  "event QuestionAdded(uint256 index, string text)",
  "event Voted(address indexed voter)",
  "event Finalized(bytes32 rulesHash, bytes32 resultsHash, uint256 claimOpenAt, uint256 claimDeadline)",
  "event PrizeFunded(address indexed funder, uint256 amount)",
  "event PrizeSwept(address indexed to, uint256 amount)",
  "function startTime() view returns (uint256)",
  "function endTime() view returns (uint256)",
] as const;
