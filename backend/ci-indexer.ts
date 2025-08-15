// backend/ci-indexer.ts
// @ts-nocheck

/**
 * D-Scope V1 indexer (no server).
 * - Reads logs from zkSync Era Sepolia
 * - Discovers surveys via Factory and Survey events
 * - Writes static artifacts to /public/api/*
 *
 * Outputs:
 *   public/api/ledger.ndjson
 *   public/api/surveys.json
 *   public/api/balances.json
 *   public/api/state.json
 */

import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { Provider } from "zksync-ethers";
import { Interface } from "ethers";
import * as hre from "hardhat";

// ---------- Load .env robustly ----------
const envPath1 = path.resolve(process.cwd(), ".env");
const envPath2 = path.resolve(__dirname, "../.env");
const chosenEnvPath = fs.existsSync(envPath1)
  ? envPath1
  : fs.existsSync(envPath2)
  ? envPath2
  : null;
if (chosenEnvPath) {
  dotenvConfig({ path: chosenEnvPath });
  console.log(`[Indexer] .env loaded from: ${chosenEnvPath}`);
} else {
  console.log(
    "[Indexer] .env file not found (will rely on defaults / CLI env)."
  );
}

// ---------- Derive config ----------
function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

// Try env → hardhat url → default zkSync Sepolia
let RPC: string =
  process.env.RPC_URL ||
  ((hre.network?.config as any)?.url as string | undefined) ||
  "https://sepolia.era.zksync.dev";

// Try env → deployments/zkSyncSepolia.json
let FACTORY: string = (process.env.FACTORY_ADDRESS || "").toLowerCase();
if (!FACTORY) {
  const depPath = path.resolve(
    process.cwd(),
    "deployments",
    "zkSyncSepolia.json"
  );
  const dep = readJSON(depPath, null as any);
  if (dep?.factory?.address) {
    FACTORY = String(dep.factory.address).toLowerCase();
    console.log(
      `[Indexer] FACTORY_ADDRESS taken from deployments/zkSyncSepolia.json: ${FACTORY}`
    );
  }
}

const START: number = Number(
  process.env.START_BLOCK ||
    readJSON(path.resolve(process.cwd(), "deployments", "zkSyncSepolia.json"), {
      factory: { deployBlock: 0 },
    })?.factory?.deployBlock ||
    0
);

// Sanity logs
console.log("[Indexer] Effective config:", {
  RPC,
  FACTORY,
  START_BLOCK: START,
});

if (!FACTORY) {
  throw new Error(
    "FACTORY_ADDRESS is required. Set it in .env or deployments/zkSyncSepolia.json.\n" +
      "Example .env:\n" +
      "  RPC_URL=https://sepolia.era.zksync.dev\n" +
      "  FACTORY_ADDRESS=0xYourFactoryAddress\n" +
      "  START_BLOCK=123456  # block of factory deployment"
  );
}

// ---------- Output files ----------
const outDir = path.join(process.cwd(), "public", "api");
const FILES = {
  STATE: path.join(outDir, "state.json"),
  LEDGER: path.join(outDir, "ledger.ndjson"),
  BAL: path.join(outDir, "balances.json"),
  SURV: path.join(outDir, "surveys.json"),
};

function ensureOutputs() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(FILES.STATE))
    fs.writeFileSync(FILES.STATE, JSON.stringify({ lastBlock: 0 }, null, 2));
  if (!fs.existsSync(FILES.LEDGER)) fs.writeFileSync(FILES.LEDGER, "");
  if (!fs.existsSync(FILES.BAL)) fs.writeFileSync(FILES.BAL, "{}");
  if (!fs.existsSync(FILES.SURV)) fs.writeFileSync(FILES.SURV, "{}");
}
const appendLedger = (o: any) =>
  fs.appendFileSync(FILES.LEDGER, JSON.stringify(o) + "\n");

// ---------- Main ----------
(async () => {
  ensureOutputs();

  // Load ABIs from artifacts (do `npx hardhat compile` before running indexer)
  const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");
  const SurveyArtifact = await hre.artifacts.readArtifact("Survey");
  const iF = new Interface(FactoryArtifact.abi);
  const iS = new Interface(SurveyArtifact.abi);

  const provider = new Provider(RPC);

  // Range
  const state = readJSON(FILES.STATE, { lastBlock: 0 });
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(START, Number(state.lastBlock || 0) + 1);
  const toBlock = latest;

  if (fromBlock > toBlock) {
    console.log(`[Indexer] No new blocks. last=${state.lastBlock}`);
    process.exit(0);
  }

  // Snapshots
  const balances: Record<string, number> = readJSON(FILES.BAL, {});
  const surveys: Record<
    string,
    { creator: string; start: number; end: number; metaHash: string }
  > = readJSON(FILES.SURV, {});
  const knownSurveyAddrs = new Set(
    Object.keys(surveys).map((a) => a.toLowerCase())
  );

  console.log(`[Indexer] Range: ${fromBlock} -> ${toBlock}`);
  const BATCH = 100;

  // Pass 1: scan all logs to discover surveys via Factory / SurveyCreated
  for (let f = fromBlock; f <= toBlock; f += BATCH) {
    const t = Math.min(f + BATCH - 1, toBlock);
    const logs = await provider.getLogs({ fromBlock: f, toBlock: t });

    for (const l of logs) {
      const addr = (l.address || "").toLowerCase();

      // Factory events
      if (addr === FACTORY) {
        try {
          const p = iF.parseLog(l);
          if (p?.name === "SurveyDeployed" || p?.name === "SurveyCreated") {
            const survey: string = (p.args.survey as string).toLowerCase();
            const creator: string =
              (p.args.creator as string)?.toLowerCase?.() || "";
            const start = Number(p.args.startTime ?? 0);
            const end = Number(p.args.endTime ?? 0);
            const metaHash = String(p.args.metaHash ?? "");

            surveys[survey] = { creator, start, end, metaHash };
            knownSurveyAddrs.add(survey);

            appendLedger({
              t: "SurveyDeployed",
              survey,
              creator,
              start,
              end,
              metaHash,
              block: l.blockNumber,
              tx: l.transactionHash,
            });
          }
        } catch {}
      }

      // Survey-created event emitted by Survey itself
      try {
        const p2 = iS.parseLog(l);
        if (p2?.name === "SurveyCreated") {
          const surveyAddr = (l.address || "").toLowerCase();
          const creator = (p2.args.creator as string)?.toLowerCase?.() || "";
          const metaHash = String(p2.args.metaHash ?? "");
          surveys[surveyAddr] = {
            creator,
            start: surveys[surveyAddr]?.start ?? 0,
            end: surveys[surveyAddr]?.end ?? 0,
            metaHash,
          };
          knownSurveyAddrs.add(surveyAddr);

          appendLedger({
            t: "SurveyCreated",
            survey: surveyAddr,
            creator,
            metaHash,
            block: l.blockNumber,
            tx: l.transactionHash,
          });
        }
      } catch {}
    }
  }

  // Pass 2: scan only known Survey addresses for inner events
  if (knownSurveyAddrs.size > 0) {
    const addrs = Array.from(knownSurveyAddrs);
    const CHUNK = 50;

    for (let f = fromBlock; f <= toBlock; f += BATCH) {
      const t = Math.min(f + BATCH - 1, toBlock);

      for (let i = 0; i < addrs.length; i += CHUNK) {
        const chunk = addrs.slice(i, i + CHUNK);
        let logs;
        try {
          logs = await provider.getLogs({
            fromBlock: f,
            toBlock: t,
            address: chunk as any,
          });
        } catch {
          logs = await provider.getLogs({ fromBlock: f, toBlock: t });
        }

        for (const l of logs) {
          const addr = (l.address || "").toLowerCase();
          if (!knownSurveyAddrs.has(addr)) continue;

          try {
            const p = iS.parseLog(l);

            if (p?.name === "QuestionAdded") {
              appendLedger({
                t: "QuestionAdded",
                survey: addr,
                index: Number(p.args.index),
                text: String(p.args.text),
                block: l.blockNumber,
                tx: l.transactionHash,
              });
            }

            if (p?.name === "Voted") {
              const voter = (p.args.voter as string).toLowerCase();
              balances[voter] = (balances[voter] || 0) + 1;
              appendLedger({
                t: "Voted",
                survey: addr,
                voter,
                block: l.blockNumber,
                tx: l.transactionHash,
              });
            }

            if (p?.name === "Finalized") {
              appendLedger({
                t: "Finalized",
                survey: addr,
                block: l.blockNumber,
                tx: l.transactionHash,
                rulesHash: p.args.rulesHash
                  ? String(p.args.rulesHash)
                  : undefined,
                resultsHash: p.args.resultsHash
                  ? String(p.args.resultsHash)
                  : undefined,
              });
            }
          } catch {}
        }
      }
    }
  }

  // Save artifacts
  fs.writeFileSync(FILES.BAL, JSON.stringify(balances, null, 2));
  fs.writeFileSync(FILES.SURV, JSON.stringify(surveys, null, 2));
  fs.writeFileSync(
    FILES.STATE,
    JSON.stringify({ lastBlock: toBlock }, null, 2)
  );

  console.log(
    `[Indexer] Done. lastBlock=${toBlock} | surveys=${
      Object.keys(surveys).length
    } | voters=${Object.keys(balances).length}`
  );
})().catch((e) => {
  console.error("[Indexer] Fatal:", e);
  process.exit(1);
});
