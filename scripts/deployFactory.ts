import { Deployer } from "@matterlabs/hardhat-zksync-deploy";
import * as hre from "hardhat";

export default async function main() {
  const wallet = new hre.ethers.Wallet(process.env.WALLET_PRIVATE_KEY!);
  const deployer = new Deployer(hre, wallet);

  const surveyArtifact = await deployer.loadArtifact("Survey");
  const factoryArtifact = await deployer.loadArtifact("SurveyFactory");

  const factory = await deployer.deploy(factoryArtifact, [], {
    customData: {
      factoryDeps: [surveyArtifact.bytecode],
    },
  });

  console.log(`✅ SurveyFactory deployed at: ${factory.address}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
