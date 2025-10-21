// backend/abi.ts

// Достаточно событий/геттеров, которые реально читает индексер.
// Если в контрактах появятся новые поля — просто дополни.

export const SURVEY_FACTORY_ABI = [
  // два возможных имени события на деплой
  "event SurveyDeployed(address indexed survey, address indexed creator, uint256 startTime, uint256 endTime, uint8 surveyType, bytes32 metaHash)",
  "event SurveyCreated(address indexed survey, address indexed creator, uint256 startTime, uint256 endTime, uint8 surveyType, bytes32 metaHash)",
] as const;

export const SURVEY_ABI = [
  // события
  "event QuestionAdded(uint256 index, string text)",
  "event Voted(address indexed voter)",
  "event Finalized(bytes32 rulesHash, bytes32 resultsHash, uint256 claimOpenAt, uint256 claimDeadline)",
  "event PrizeFunded(address indexed funder, uint256 amount)",
  "event PrizeSwept(address indexed to, uint256 amount)",

  // геттеры расписания (в некоторых билдах могли называться start/end)
  "function startTime() view returns (uint256)",
  "function endTime() view returns (uint256)",
  "function start() view returns (uint256)",
  "function end() view returns (uint256)",
] as const;
