import { Deployer } from "@matterlabs/hardhat-zksync-deploy";
import * as hre from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { Wallet } from "zksync-ethers";

async function main() {
  const pk = process.env.WALLET_PRIVATE_KEY;
  const ATTESTER = process.env.ATTESTER; // EOA или Safe (1271)
  if (!pk) throw new Error("WALLET_PRIVATE_KEY is missing in .env");
  if (!ATTESTER) throw new Error("ATTESTER is missing in .env");

  const wallet = new Wallet(pk);
  const deployer = new Deployer(hre, wallet);

  // 1) Gate
  const GateArt = await deployer.loadArtifact("EligibilityGateEIP712");
  const gate = await deployer.deploy(GateArt, [ATTESTER]);
  const gateAddr = await gate.getAddress();
  const gateTx = gate.deploymentTransaction();
  const gateRc = await gateTx!.wait();
  console.log("EligibilityGateEIP712:", gateAddr, "block:", gateRc.blockNumber);

  // 2) Factory
  const FactoryArt = await deployer.loadArtifact("SurveyFactory");
  const factory = await deployer.deploy(FactoryArt, []);
  const factoryAddr = await factory.getAddress();
  const factoryTx = factory.deploymentTransaction();
  const factoryRc = await factoryTx!.wait();
  console.log("SurveyFactory:", factoryAddr, "block:", factoryRc.blockNumber);

  // 3) Save deployments/zkSyncSepolia.json for indexer
  const out = {
    gate: { address: gateAddr, deployBlock: Number(gateRc.blockNumber) },
    factory: {
      address: factoryAddr,
      deployBlock: Number(factoryRc.blockNumber),
    },
  };
  const p = path.resolve(process.cwd(), "deployments", "zkSyncSepolia.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("Saved:", p);

  // 4) Hint for .env
  console.log("\nNext .env:");
  console.log("FACTORY_ADDRESS=" + factoryAddr);
  console.log("START_BLOCK=" + factoryRc.blockNumber);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
