// backend/ci-indexer.ts
// @ts-nocheck

/**
 * D-Scope V1 indexer — single factory only, Scroll Sepolia.
 * FIXED: ABI mismatch, single factory mode, metaHash parsing.
 */

import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import {
  Interface,
  keccak256,
  toUtf8Bytes,
  parseEther,
  Contract,
  JsonRpcProvider,
} from "ethers";
import { SURVEY_FACTORY_ABI, SURVEY_ABI } from "./abi";

// ---------- Load .env ----------
const env1 = path.resolve(process.cwd(), ".env");
const env2 = path.resolve(__dirname, "../.env");
const envPath = fs.existsSync(env1) ? env1 : fs.existsSync(env2) ? env2 : null;
if (envPath) dotenvConfig({ path: envPath, override: true });

// ---------- Config ----------
const CHAIN_ID = Number(process.env.CHAIN_ID || 534351);
const RPC =
  process.env.SCROLL_RPC ||
  process.env.RPC_URL ||
  "https://sepolia-rpc.scroll.io";

const FACTORY_ADDRESS = (process.env.FACTORY_ADDRESS || "")
  .toLowerCase()
  .trim();

if (!FACTORY_ADDRESS) {
  throw new Error("FACTORY_ADDRESS is required in .env");
}

const START_BLOCK = Number(process.env.START_BLOCK) || 0;
const ONLY_LAST_BLOCKS = Number(process.env.ONLY_LAST_BLOCKS || 0);
const TREASURY_SAFE = String(process.env.TREASURY_SAFE || "").toLowerCase();
const MIN_CONF = Number(process.env.MIN_CONF || 2);
const GATE_ADDR_HINT = (process.env.GATE_ADDR || "").toLowerCase();

const OUTPUT_DIR =
  process.env.OUTPUT_DIR && process.env.OUTPUT_DIR.trim()
    ? path.resolve(process.cwd(), process.env.OUTPUT_DIR.trim())
    : path.resolve(process.cwd(), "../dscope-api/api");

console.log("[Indexer] Config", {
  RPC,
  CHAIN_ID,
  FACTORY_ADDRESS,
  START_BLOCK,
  OUTPUT_DIR,
});

// ---------- Output files ----------
const outDir = OUTPUT_DIR;
const metaDir = path.join(outDir, "meta", String(CHAIN_ID));
const fundingDir = path.join(outDir, "funding", String(CHAIN_ID));

const FILES = {
  STATE: path.join(outDir, "state.json"),
  LEDGER: path.join(outDir, "ledger.ndjson"),
  BAL: path.join(outDir, "balances.json"),
  GATES: path.join(outDir, "gates.json"),
};

function ensureOutputs() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
  if (!fs.existsSync(fundingDir)) fs.mkdirSync(fundingDir, { recursive: true });
  if (!fs.existsSync(FILES.STATE))
    fs.writeFileSync(FILES.STATE, JSON.stringify({ lastBlock: 0 }, null, 2));
  if (!fs.existsSync(FILES.LEDGER)) fs.writeFileSync(FILES.LEDGER, "");
  if (!fs.existsSync(FILES.BAL)) fs.writeFileSync(FILES.BAL, "{}");
}

const appendLedger = (o: any) =>
  fs.appendFileSync(FILES.LEDGER, JSON.stringify(o) + "\n");

// ---------- Helpers ----------
function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function toSec(x: any) {
  const n = Number(x || 0);
  return n > 2e10 ? Math.floor(n / 1000) : Math.floor(n);
}
const nowSec = () => Math.floor(Date.now() / 1000);

// ---------- Main ----------
(async () => {
  ensureOutputs();

  const iF = new Interface(SURVEY_FACTORY_ABI);
  const iS = new Interface(SURVEY_ABI);

  const provider = new JsonRpcProvider(RPC);
  const state = readJSON(FILES.STATE, { lastBlock: 0 });
  const latest = await provider.getBlockNumber();

  const fromByState = Number(state.lastBlock || 0) + 1;
  const fromByStart = Math.max(Number(START_BLOCK) || 0, 0);
  const fromByTail = ONLY_LAST_BLOCKS
    ? Math.max(latest - ONLY_LAST_BLOCKS + 1, 0)
    : 0;
  const fromBlock = Math.max(fromByState, fromByStart, fromByTail);
  const toBlock = latest;

  console.log(`[Indexer] Scan: ${fromBlock} → ${toBlock}`);

  const balances: Record<string, number> = readJSON(FILES.BAL, {});

  const BATCH = 1000;

  // block timestamp cache
  const tsCache = new Map<number, number>();
  async function blockTs(n: number) {
    if (!n) return 0;
    if (tsCache.has(n)) return tsCache.get(n)!;
    const b = await provider.getBlock(n);
    const ts = Number(b?.timestamp || 0);
    tsCache.set(n, ts);
    return ts;
  }

  // -------- Scan factory logs (only for ledger + balances) --------
  if (fromBlock <= toBlock) {
    for (let f = fromBlock; f <= toBlock; f += BATCH) {
      const t = Math.min(f + BATCH - 1, toBlock);
      let logs: any[] = [];
      try {
        logs = await provider.getLogs({
          fromBlock: f,
          toBlock: t,
          address: FACTORY_ADDRESS,
        });
      } catch (err) {
        console.warn(`Failed to fetch logs for block range ${f}-${t}:`, err);
        continue;
      }

      for (const l of logs) {
        if ((l.address || "").toLowerCase() !== FACTORY_ADDRESS) continue;

        try {
          const p = iF.parseLog(l);
          if (p?.name === "SurveyDeployed") {
            const survey = (p.args.survey as string).toLowerCase();
            const creator = (p.args.creator as string)?.toLowerCase?.() || "";
            const start = toSec(Number(p.args.startTime ?? 0));
            const end = toSec(Number(p.args.endTime ?? 0));
            const surveyType = Number(p.args.surveyType ?? 0);
            const metaHash = String(p.args.metaHash ?? "");
            const plannedReward = String(p.args.plannedReward ?? "0");
            const initialValue = String(p.args.initialValue ?? "0");
            const ts = await blockTs(l.blockNumber);

            appendLedger({
              t: "SurveyDeployed",
              survey,
              creator,
              start,
              end,
              metaHash,
              surveyType,
              plannedReward,
              initialValue,
              block: l.blockNumber,
              ts,
              tx: l.transactionHash,
            });
          }
        } catch (e) {
          console.warn("Failed to parse log:", e);
        }
      }
    }
  }

  // -------- Scan all known surveys for Voted events (analytics only) --------
  // (optional: you can skip this if you don't need balances)
  // For brevity, we keep only the core scan above

  // -------- Save analytics & state --------
  fs.writeFileSync(FILES.BAL, JSON.stringify(balances, null, 2));

  // state.json
  fs.writeFileSync(
    FILES.STATE,
    JSON.stringify(
      {
        network: "Scroll Sepolia",
        chainId: CHAIN_ID,
        factoryAddress: FACTORY_ADDRESS,
        treasurySafe: TREASURY_SAFE || null,
        lastBlock: toBlock,
        updatedAt: nowSec(),
      },
      null,
      2
    )
  );

  // gates.json — needed for frontend predicates
  const eip712 = {
    domain: {
      name: "DScopeEligibility",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: GATE_ADDR_HINT || "",
    },
    types: {
      Eligibility: [
        { name: "user", type: "address" },
        { name: "survey", type: "address" },
        { name: "nullifier", type: "bytes32" },
        { name: "deadline", type: "uint256" },
        { name: "chainId", type: "uint256" },
      ],
    },
  };
  fs.writeFileSync(
    FILES.GATES,
    JSON.stringify({ eip712, updatedAt: nowSec() }, null, 2)
  );

  console.log(`[Indexer] Done. Analytics updated.`);
})().catch((e) => {
  console.error("[Indexer] Fatal:", e);
  process.exit(1);
});
