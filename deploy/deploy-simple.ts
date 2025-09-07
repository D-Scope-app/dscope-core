import { utils, Wallet } from "zksync-ethers";
import * as ethers from "ethers";
import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Deployer } from "@matterlabs/hardhat-zksync-deploy";

export default async function (hre: HardhatRuntimeEnvironment) {
  console.log(`Running simple deploy script for the SurveyFactory contract`);

  const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY || "");
  const deployer = new Deployer(hre, wallet);
  const factoryArtifact = await deployer.loadArtifact("SurveyFactory");

  // Деплой контракта SurveyFactory
  const factoryContract = await deployer.deploy(factoryArtifact);
  const contractAddress = factoryContract.address;

  console.log(`SurveyFactory was deployed to ${contractAddress}`);
  console.log("Please copy this address for manual verification.");
}
