// scripts/deploy-factory-flat.js
const hre = require("hardhat");
const { Provider, Wallet, ContractFactory } = require("zksync-ethers");

(async () => {
  const pk = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("WALLET_PRIVATE_KEY is missing in .env");

  const rpc = process.env.ZKSYNC_RPC || "https://sepolia.era.zksync.dev";
  const provider = new Provider(rpc);
  const wallet = new Wallet(pk, provider);
  console.log("Deployer:", wallet.address);

  const art = await hre.artifacts.readArtifact("SurveyFactoryFlat");
  const factory = new ContractFactory(art.abi, art.bytecode, wallet);
  const inst = await factory.deploy();
  const rc = await inst.deploymentTransaction().wait();
  const addr = await inst.getAddress();
  console.log("SurveyFactoryFlat:", addr, "block:", rc.blockNumber);
})().catch(e => { console.error(e); process.exit(1); });
