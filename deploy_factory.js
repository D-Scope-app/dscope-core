const hre = require("hardhat");

async function main() {
  const Factory = await hre.ethers.getContractFactory("SurveyFactory");
  const factory = await Factory.deploy();
  await factory.waitForDeployment();
  const address = await factory.getAddress();
  console.log("✅ New SurveyFactory deployed to:", address);

  // Сразу верифицируем
  await hre.run("verify:verify", { address });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
