// scripts/deploy.ts
import { ethers, run, network } from "hardhat";

async function verify(address: string, args: any[] = []) {
  try {
    await run("verify:verify", { address, constructorArguments: args });
    console.log(`✔ Verified: ${address}`);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (/Already Verified/i.test(msg)) {
      console.log(`= Already verified: ${address}`);
    } else {
      console.warn(`! Verify failed for ${address}:`, msg);
    }
  }
}

async function main() {
  console.log(`\n=== D-Scope deploy → ${network.name} ===`);

  const [deployer] = await ethers.getSigners();
  const deployerAddr = await deployer.getAddress();
  const bal = await ethers.provider.getBalance(deployerAddr);

  console.log(`Deployer: ${deployerAddr}`);
  console.log(`Balance : ${ethers.formatEther(bal)} ETH`);

  // ----- 1) Deploy EligibilityGateEIP712 -----
  const gateAttester = process.env.GATE_ATTESTER?.trim() || deployerAddr;
  console.log(
    `\n→ Deploying EligibilityGateEIP712 with attester: ${gateAttester}`
  );

  const Gate = await ethers.getContractFactory("EligibilityGateEIP712");
  const gate = await Gate.deploy(gateAttester);
  const gateReceipt = await gate.deploymentTransaction()?.wait();
  const gateAddr = await gate.getAddress();

  console.log(`EligibilityGateEIP712 @ ${gateAddr}`);
  if (gateReceipt) console.log(`tx: ${gateReceipt.hash}`);

  // ----- 2) Deploy SurveyFactory (обычная, не Flat) -----
  console.log(`\n→ Deploying SurveyFactory`);
  const Factory = await ethers.getContractFactory("SurveyFactory");
  const factory = await Factory.deploy(); // без аргументов
  const factoryReceipt = await factory.deploymentTransaction()?.wait();
  const factoryAddr = await factory.getAddress();

  console.log(`SurveyFactory @ ${factoryAddr}`);
  if (factoryReceipt) console.log(`tx: ${factoryReceipt.hash}`);

  // ----- 3) Optional: verify -----
  if (process.env.VERIFY === "1") {
    console.log(`\n→ Verifying on explorer...`);
    await verify(gateAddr, [gateAttester]);
    await verify(factoryAddr, []);
  }

  console.log(`\n=== Done ===`);
  console.log(
    JSON.stringify(
      { network: network.name, gate: gateAddr, factory: factoryAddr },
      null,
      2
    )
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
