/**
 * Redeploy SurveyFactory and immediately verify it on zkSync Era Sepolia.
 * JS version (CommonJS).
 */
const hre = require("hardhat");
const { Provider, Wallet, ContractFactory } = require("zksync-ethers");
const fs = require("fs");
const path = require("path");

async function main() {
  const pk  = (process.env.WALLET_PRIVATE_KEY || "").trim();
  const rpc = process.env.ZKSYNC_RPC || "https://sepolia.era.zksync.dev";
  if (!pk) throw new Error("WALLET_PRIVATE_KEY is missing in .env");

  const provider = new Provider(rpc);
  const wallet   = new Wallet(pk, provider);
  console.log("Deployer:", wallet.address);

  // 1) Deploy SurveyFactory (no constructor args)
  const art = await hre.artifacts.readArtifact("SurveyFactory");
  const F   = new ContractFactory(art.abi, art.bytecode, wallet);
  const c   = await F.deploy();
  const rc  = await c.deploymentTransaction().wait();
  const addr = await c.getAddress();
  console.log("SurveyFactory NEW:", addr, "block:", rc.blockNumber);

  // 2) Save/update deployments/zkSyncSepolia.json
  const outPath = path.resolve(process.cwd(), "deployments", "zkSyncSepolia.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const prev = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : {};
  const next = { ...prev, factory: { address: addr, deployBlock: Number(rc.blockNumber) } };
  fs.writeFileSync(outPath, JSON.stringify(next, null, 2));
  console.log("Saved:", outPath);

  // 3) Verify via hardhat-zksync-verify
  try {
    await hre.run("verify:verify", {
      address: addr,
      contract: "contracts/factory/SurveyFactory.sol:SurveyFactory",
      constructorArguments: [],
    });
    console.log("Verification submitted.");
  } catch (e) {
    console.error("Auto-verify failed. You can retry manually with:");
    console.error(`npx hardhat verify --network zkSyncSepolia --contract "contracts/factory/SurveyFactory.sol:SurveyFactory" ${addr}`);
    throw e;
  }

  console.log("\nUpdate your .env:");
  console.log("FACTORY_ADDRESS=" + addr);
  console.log("START_BLOCK=" + rc.blockNumber);
}

main().catch((e) => { console.error(e); process.exit(1); });
