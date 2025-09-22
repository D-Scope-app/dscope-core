// scripts/check-bytecode.js
const { Provider } = require("zksync-ethers");
const fs = require("fs");
const path = require("path");

(async () => {
  const addr = (process.argv[2] || "").trim();
  if (!addr || !addr.startsWith("0x")) {
    console.error(
      "Usage: npx hardhat run scripts/check-bytecode.js --network zkSyncSepolia <ADDRESS>"
    );
    process.exit(1);
  }

  const rpc = process.env.ZKSYNC_RPC || "https://sepolia.era.zksync.dev";
  const provider = new Provider(rpc);

  // 1) байткод на адресе (runtime code)
  const onchain = (await provider.getCode(addr)).toLowerCase();

  // 2) локальный артефакт от одного файла
  const artPath = path.join(
    process.cwd(),
    "artifacts-zk",
    "contracts",
    "release",
    "SurveyFactoryFlat.sol",
    "SurveyFactoryFlat.json"
  );
  if (!fs.existsSync(artPath)) {
    console.error("Artifact not found:", artPath);
    process.exit(1);
  }
  const art = JSON.parse(fs.readFileSync(artPath, "utf8"));

  // у zksync-артефактов runtime-байткод лежит в поле "deployedBytecode"
  // (иногда как строка, иногда как объект с "object")
  let local = art.deployedBytecode;
  if (local && typeof local === "object" && local.object) local = local.object;
  if (!local || typeof local !== "string") {
    console.error("Can't read deployedBytecode from artifact JSON");
    process.exit(1);
  }
  local = local.toLowerCase();

  console.log("onchain len:", onchain.length, "local len:", local.length);
  console.log(
    "prefix onchain:",
    onchain.slice(0, 18),
    "...",
    onchain.slice(-20)
  );
  console.log("prefix local  :", local.slice(0, 18), "...", local.slice(-20));
  console.log(local === onchain ? "MATCH ✅" : "DIFF ❌");
})();
