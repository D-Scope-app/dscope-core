// scripts/deploy-factory.ts
import * as hre from "hardhat";
import { Provider, Wallet, ContractFactory } from "zksync-ethers";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  if (!process.env.WALLET_PRIVATE_KEY) {
    throw new Error("Set WALLET_PRIVATE_KEY in .env");
  }

  const rpc = hre.network.config.url as string;
  const provider = new Provider(rpc);
  const owner = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

  console.log("[Deploy] RPC:", rpc);
  console.log("[Deploy] Deployer:", await owner.getAddress());

  const art = await hre.artifacts.readArtifact("SurveyFactory");
  const fac = new ContractFactory(art.abi, art.bytecode, owner);

  const c = await fac.deploy();
  await c.waitForDeployment();

  const addr = await c.getAddress();
  const r = await provider.getTransactionReceipt(
    c.deploymentTransaction()!.hash
  );

  console.log("✅ SurveyFactory:", addr);
  console.log("✅ Deploy block:", r.blockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
