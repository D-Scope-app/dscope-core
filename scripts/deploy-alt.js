// scripts/deploy-alt.js
const hre = require("hardhat");
const { Provider, Wallet, ContractFactory } = require("zksync-ethers");
const { getAddress } = require("ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  console.log("SCRIPT_VERSION:", "gate-ctor-address-v1");

  const pk = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!pk) throw new Error("WALLET_PRIVATE_KEY is missing in .env");

  const rpc = process.env.ZKSYNC_RPC || "https://sepolia.era.zksync.dev";
  const provider = new Provider(rpc);
  const wallet = new Wallet(pk, provider);
  console.log("Deployer:", wallet.address);

  // Gate (ctor: address _attester)
  const GateArt = await hre.artifacts.readArtifact("EligibilityGateEIP712");
  const GateFactory = new ContractFactory(GateArt.abi, GateArt.bytecode, wallet);
  const attester = getAddress(wallet.address);
  console.log("Attester for Gate:", attester);
  const gate = await GateFactory.deploy(attester);
  const gateRc = await gate.deploymentTransaction().wait();
  const gateAddr = await gate.getAddress();
  console.log("EligibilityGateEIP712:", gateAddr, "block:", gateRc.blockNumber);

  // Factory (no args)
  const FactoryArt = await hre.artifacts.readArtifact("SurveyFactory");
  const FactoryFactory = new ContractFactory(FactoryArt.abi, FactoryArt.bytecode, wallet);
  const factory = await FactoryFactory.deploy();
  const factoryRc = await factory.deploymentTransaction().wait();
  const factoryAddr = await factory.getAddress();
  console.log("SurveyFactory:", factoryAddr, "block:", factoryRc.blockNumber);

  const out = {
    gate:    { address: gateAddr,    deployBlock: Number(gateRc.blockNumber) },
    factory: { address: factoryAddr, deployBlock: Number(factoryRc.blockNumber) }
  };
  const p = path.resolve(process.cwd(), "deployments", "zkSyncSepolia.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(out, null, 2));
  console.log("Saved:", p);

  console.log("GATE_ADDR=" + gateAddr);
  console.log("FACTORY_ADDRESS=" + factoryAddr);
  console.log("START_BLOCK=" + factoryRc.blockNumber);
})().catch(e => { console.error(e); process.exit(1); });
