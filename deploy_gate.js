const hre = require("hardhat");

async function main() {
  console.log("Deploying ZkPassEligibilityGate...");

  const Gate = await hre.ethers.getContractFactory("ZkPassEligibilityGate");
  const gate = await Gate.deploy();
  await gate.waitForDeployment();

  const gateAddress = await gate.getAddress();
  console.log("✅ ZkPassEligibilityGate deployed to:", gateAddress);

  // Автоматическая верификация
  try {
    console.log("Verifying on Blockscout...");
    await hre.run("verify:verify", {
      address: gateAddress,
    });
    console.log("✅ Verified!");
  } catch (e) {
    console.log("⚠️ Verification failed (maybe already verified):", e.message);
  }

  return gateAddress;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
