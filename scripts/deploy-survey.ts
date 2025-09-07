import { Wallet, Provider, ContractFactory } from "zksync-ethers";
import * as hre from "hardhat";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const provider = new Provider(hre.network.config.url);
  const wallet = new Wallet(process.env.PRIVATE_KEY!, provider);

  // Step 1: Deploy implementation
  const SurveyArtifact = await hre.artifacts.readArtifact("Survey");
  const SurveyFactoryContract = new ContractFactory(
    SurveyArtifact.abi,
    SurveyArtifact.bytecode,
    wallet
  );
  const surveyImpl = await SurveyFactoryContract.deploy();
  await surveyImpl.waitForDeployment();

  console.log(
    "✅ Survey implementation deployed:",
    await surveyImpl.getAddress()
  );

  // Step 2: Deploy SurveyFactory with implementation address
  const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");
  const FactoryFactory = new ContractFactory(
    FactoryArtifact.abi,
    FactoryArtifact.bytecode,
    wallet
  );
  const surveyFactory = await FactoryFactory.deploy(
    await surveyImpl.getAddress()
  );
  await surveyFactory.waitForDeployment();

  console.log("✅ SurveyFactory deployed:", await surveyFactory.getAddress());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
