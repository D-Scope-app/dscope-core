import * as hre from "hardhat";
import { Provider, Wallet, ContractFactory } from "zksync-ethers";
import dotenv from "dotenv";
dotenv.config();

async function main() {
  const provider = new Provider(hre.network.config.url);
  const owner = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

  const art = await hre.artifacts.readArtifact("SurveyFactory");
  const fac = new ContractFactory(art.abi, art.bytecode, owner);
  const c = await fac.deploy();
  await c.waitForDeployment();

  const addr = await c.getAddress();
  const r = await provider.getTransactionReceipt(
    c.deploymentTransaction()!.hash
  );
  console.log("SurveyFactory:", addr);
  console.log("Deploy block:", r.blockNumber);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
