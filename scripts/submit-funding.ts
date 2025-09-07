// scripts/submit-funding.ts
// @ts-nocheck
import * as fs from "fs";
import * as path from "path";

function usage() {
  console.log(
    "Usage:\n" +
      "  npx ts-node scripts/submit-funding.ts --survey=0xSurveyAddress --tx=0xTxHash --chain=300\n" +
      "\nThis will write: public/api/funding/<chain>/<survey>.json"
  );
}

const args = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const [k, v] = a.split("=");
  args.set(k.replace(/^--/, ""), v || "");
}

const survey = (args.get("survey") || "").toLowerCase();
const tx = args.get("tx") || args.get("txhash") || "";
const chain = args.get("chain") || "300";

if (!/^0x[a-fA-F0-9]{40}$/.test(survey) || !/^0x[a-fA-F0-9]{64}$/.test(tx)) {
  usage();
  process.exit(1);
}

const outDir = path.join(
  process.cwd(),
  "public",
  "api",
  "funding",
  String(chain)
);
const outFile = path.join(outDir, `${survey}.json`);
fs.mkdirSync(outDir, { recursive: true });

const payload = {
  survey,
  txHash: tx,
  createdAt: Date.now(),
};

fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
console.log("Wrote funding submission:", outFile);
