import { Wallet, Provider, utils } from "zksync-ethers";
import * as hre from "hardhat";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const zkProvider = new Provider(process.env.ZKSYNC_RPC!);
  const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, zkProvider);

  const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");
  const factoryFactory = new hre.zksync.ContractFactory(
    FactoryArtifact.abi,
    FactoryArtifact.bytecode,
    wallet
  );

  const factory = await factoryFactory.deploy();
  await factory.deployed();

  console.log("SurveyFactory deployed to:", factory.address);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
