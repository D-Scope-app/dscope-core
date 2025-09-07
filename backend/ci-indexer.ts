// backend/ci-indexer.ts
// @ts-nocheck

/**
 * D-Scope V1 indexer (no server).
 * - Reads logs from zkSync Era Sepolia
 * - Discovers surveys via Factory and Survey events
 * - Enriches with local meta JSON (public/api/meta/<chainId>/<survey>.json)
 * - Verifies off-chain treasury funding via submitted tx hashes (public/api/funding/<chainId>/*.json)
 * - Writes static artifacts to /public/api/*
 *
 * Outputs:
 *   public/api/ledger.ndjson
 *   public/api/surveys.json
 *   public/api/balances.json
 *   public/api/state.json
 *   public/api/surveys.list.json
 */

import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
import { Provider } from "zksync-ethers";
import { Interface, keccak256, toUtf8Bytes, parseEther } from "ethers";
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

// ---------- Helpers ----------
function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function canonicalize(obj: any) {
  // stable key order
  const keys = Object.keys(obj).sort();
  const out: any = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}

// ---------- Config ----------
const CHAIN_ID: number = Number(process.env.CHAIN_ID || 300);

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

// Off-chain treasury (Safe) funding
const TREASURY_SAFE = String(process.env.TREASURY_SAFE || "").toLowerCase(); // REQUIRED for funding verification
const MIN_CONF = Number(process.env.MIN_CONFIRMATIONS || 2); // confirmations before we accept funding

// Optional tail scan for local dev
const ONLY_LAST = Number(process.env.ONLY_LAST_BLOCKS || 0);

// Sanity logs
console.log("[Indexer] Effective config:", {
  RPC,
  FACTORY,
  START_BLOCK: START,
  ONLY_LAST_BLOCKS: ONLY_LAST,
  CHAIN_ID,
  TREASURY_SAFE,
  MIN_CONF,
});

if (!FACTORY) {
  throw new Error(
    "FACTORY_ADDRESS is required. Set it in .env or deployments/zkSyncSepolia.json.\n" +
      "Example .env:\n" +
      "  RPC_URL=https://sepolia.era.zksync.dev\n" +
      "  FACTORY_ADDRESS=0x834C01032cdF2C35b725f73F9CCF0d227392228c\n" +
      "  START_BLOCK=123456  # block of factory deployment\n" +
      "  CHAIN_ID=300        # zkSync Era Sepolia\n" +
      "  TREASURY_SAFE=0xYourSafeAddress\n" +
      "  MIN_CONFIRMATIONS=2"
  );
}
if (!TREASURY_SAFE) {
  console.warn(
    "[Indexer] TREASURY_SAFE is empty — funding verification will be skipped."
  );
}

// ---------- Output files ----------
const outDir = path.join(process.cwd(), "public", "api");
const metaDir = path.join(outDir, "meta", String(CHAIN_ID));
const fundingDir = path.join(outDir, "funding", String(CHAIN_ID)); // user-submitted tx hashes

const FILES = {
  STATE: path.join(outDir, "state.json"),
  LEDGER: path.join(outDir, "ledger.ndjson"),
  BAL: path.join(outDir, "balances.json"),
  SURV: path.join(outDir, "surveys.json"),
  LIST: path.join(outDir, "surveys.list.json"),
};

function ensureOutputs() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(metaDir)) fs.mkdirSync(metaDir, { recursive: true });
  if (!fs.existsSync(fundingDir)) fs.mkdirSync(fundingDir, { recursive: true });
  if (!fs.existsSync(FILES.STATE))
    fs.writeFileSync(FILES.STATE, JSON.stringify({ lastBlock: 0 }, null, 2));
  if (!fs.existsSync(FILES.LEDGER)) fs.writeFileSync(FILES.LEDGER, "");
  if (!fs.existsSync(FILES.BAL)) fs.writeFileSync(FILES.BAL, "{}");
  if (!fs.existsSync(FILES.SURV)) fs.writeFileSync(FILES.SURV, "{}");
  if (!fs.existsSync(FILES.LIST)) fs.writeFileSync(FILES.LIST, "[]");
}
const appendLedger = (o: any) =>
  fs.appendFileSync(FILES.LEDGER, JSON.stringify(o) + "\n");

// ---------- Meta enrich ----------
function readLocalMeta(surveyAddr: string) {
  const localPath = path.join(metaDir, `${surveyAddr}.json`);
  if (!fs.existsSync(localPath)) {
    return {
      meta: null,
      metaValid: false,
      title: "Untitled",
      plannedRewardEth: "0",
      plannedRewardWei: "0",
      metaUrl: `/api/meta/${CHAIN_ID}/${surveyAddr}.json`,
    };
  }
  try {
    const raw = fs.readFileSync(localPath, "utf8");
    const meta = JSON.parse(raw);
    const title = (meta?.title ?? "Untitled").toString();
    const plannedRewardEth = (meta?.plannedReward ?? "0").toString();
    let plannedRewardWei = "0";
    try {
      plannedRewardWei = parseEther(plannedRewardEth).toString();
    } catch {
      plannedRewardWei = "0";
    }
    return {
      meta,
      metaValid: false, // will validate against on-chain metaHash later
      title,
      plannedRewardEth,
      plannedRewardWei,
      metaUrl: `/api/meta/${CHAIN_ID}/${surveyAddr}.json`,
    };
  } catch {
    return {
      meta: null,
      metaValid: false,
      title: "Untitled",
      plannedRewardEth: "0",
      plannedRewardWei: "0",
      metaUrl: `/api/meta/${CHAIN_ID}/${surveyAddr}.json`,
    };
  }
}

// ---------- Funding submissions (off-chain) ----------
type FundingSubmission = {
  survey: string;
  txHash: string;
  createdAt?: number;
  note?: string;
};
function readFundingSubmissions(): FundingSubmission[] {
  const list: FundingSubmission[] = [];
  try {
    const files = fs.readdirSync(fundingDir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const full = path.join(fundingDir, f);
        const j = JSON.parse(fs.readFileSync(full, "utf8"));
        if (j?.survey && j?.txHash) {
          list.push({
            survey: String(j.survey).toLowerCase(),
            txHash: String(j.txHash),
            createdAt: Number(j.createdAt || 0),
            note: j.note ? String(j.note) : undefined,
          });
        }
      } catch {
        /* ignore invalid */
      }
    }
  } catch {
    /* empty */
  }
  return list;
}

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
  const fromByState = Number(state.lastBlock || 0) + 1;
  const fromByStart = Math.max(START, 0);
  const fromByTail = ONLY_LAST ? Math.max(latest - ONLY_LAST + 1, 0) : 0;
  const fromBlock = Math.max(fromByState, fromByStart, fromByTail);
  const toBlock = latest;

  if (fromBlock > toBlock) {
    console.log(`[Indexer] No new blocks. last=${state.lastBlock}`);
    process.exit(0);
  }

  // Snapshots
  const balances: Record<string, number> = readJSON(FILES.BAL, {});
  const surveys: Record<
    string,
    {
      creator: string;
      start: number;
      end: number;
      metaHash: string; // bytes32 hex (from events)
      surveyType?: number; // 0/1
      prizeFunded?: string; // wei as decimal string (accumulated, on-chain pool)
      prizeSwept?: string; // wei as decimal string (accumulated)
      prizeLiveBalance?: string; // wei (current on-chain balance)
      // meta enrich:
      title?: string;
      metaValid?: boolean;
      metaUrl?: string;
      plannedRewardEth?: string; // from meta (string)
      plannedRewardWei?: string; // computed
      // off-chain treasury funding:
      funded?: boolean;
      fundingTxHash?: string | null;
    }
  > = readJSON(FILES.SURV, {});
  const knownSurveyAddrs = new Set(
    Object.keys(surveys).map((a) => a.toLowerCase())
  );

  console.log(`[Indexer] Range: ${fromBlock} -> ${toBlock}`);
  const BATCH = 100;

  // -------- Pass 1: scan all logs to discover surveys via Factory / SurveyCreated
  for (let f = fromBlock; f <= toBlock; f += BATCH) {
    const t = Math.min(f + BATCH - 1, toBlock);
    const logs = await provider.getLogs({ fromBlock: f, toBlock: t });

    for (const l of logs) {
      const addr = (l.address || "").toLowerCase();

      // Factory events (SurveyDeployed is the canonical source for start/end/surveyType/metaHash)
      if (addr === FACTORY) {
        try {
          const p = iF.parseLog(l);
          if (p?.name === "SurveyDeployed" || p?.name === "SurveyCreated") {
            const survey = (p.args.survey as string).toLowerCase();
            const creator = (p.args.creator as string)?.toLowerCase?.() || "";
            const start = Number(p.args.startTime ?? p.args.start ?? 0);
            const end = Number(p.args.endTime ?? p.args.end ?? 0);
            const surveyType = Number(p.args.surveyType ?? 0);
            const metaHash = String(p.args.metaHash ?? "");

            surveys[survey] = {
              ...(surveys[survey] || {}),
              creator,
              start,
              end,
              metaHash,
              surveyType,
              funded: surveys[survey]?.funded ?? false,
              fundingTxHash: surveys[survey]?.fundingTxHash ?? null,
            };
            knownSurveyAddrs.add(survey);

            appendLedger({
              t: "SurveyDeployed",
              survey,
              creator,
              start,
              end,
              metaHash,
              surveyType,
              block: l.blockNumber,
              tx: l.transactionHash,
            });
          }
        } catch {
          /* ignore non-matching logs */
        }
      }

      // Survey's own event (SurveyCreated) – confirms metaHash/creator (older/newer variants)
      try {
        const p2 = iS.parseLog(l);
        if (p2?.name === "SurveyCreated") {
          const surveyAddr = (l.address || "").toLowerCase();
          const creator = (p2.args.creator as string)?.toLowerCase?.() || "";
          const metaHash = String(p2.args.metaHash ?? "");

          surveys[surveyAddr] = {
            ...(surveys[surveyAddr] || {}),
            creator,
            start: surveys[surveyAddr]?.start ?? 0,
            end: surveys[surveyAddr]?.end ?? 0,
            metaHash,
            funded: surveys[surveyAddr]?.funded ?? false,
            fundingTxHash: surveys[surveyAddr]?.fundingTxHash ?? null,
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
      } catch {
        /* ignore */
      }
    }
  }

  // -------- Enrich with META (title, plannedReward, hash validation)
  for (const sAddr of Array.from(knownSurveyAddrs)) {
    const rec = surveys[sAddr] || (surveys[sAddr] = {} as any);
    const {
      meta,
      metaValid,
      title,
      plannedRewardEth,
      plannedRewardWei,
      metaUrl,
    } = readLocalMeta(sAddr);

    // validate metaHash if both present
    let valid = metaValid;
    if (meta && rec.metaHash) {
      try {
        const localCanon = canonicalize(meta);
        const localHash = keccak256(toUtf8Bytes(localCanon));
        valid = localHash.toLowerCase() === rec.metaHash.toLowerCase();
      } catch {
        valid = false;
      }
    }

    surveys[sAddr] = {
      ...rec,
      title,
      plannedRewardEth,
      plannedRewardWei,
      metaValid: !!valid,
      metaUrl,
      funded: rec.funded ?? false,
      fundingTxHash: rec.fundingTxHash ?? null,
    };
  }

  // -------- Pass 2: scan only known Survey addresses for inner events (questions, votes, prize, finalize)
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
          // Fallback if provider address-filtering fails
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
                claimOpenAt: p.args.claimOpenAt
                  ? Number(p.args.claimOpenAt)
                  : undefined,
                claimDeadline: p.args.claimDeadline
                  ? Number(p.args.claimDeadline)
                  : undefined,
              });
            }

            // --- Prize pool events (if your Survey.sol emits them) ---
            if (p?.name === "PrizeFunded") {
              const funder = (p.args.funder as string)?.toLowerCase?.() || "";
              const amountStr =
                p.args.amount?.toString?.() ?? String(p.args.amount);
              const prevFund = BigInt(surveys[addr]?.prizeFunded || "0");
              surveys[addr] = {
                ...(surveys[addr] || {}),
                prizeFunded: (prevFund + BigInt(amountStr)).toString(),
              };
              appendLedger({
                t: "PrizeFunded",
                survey: addr,
                funder,
                amount: amountStr,
                block: l.blockNumber,
                tx: l.transactionHash,
              });
            }

            if (p?.name === "PrizeSwept") {
              const toAddr = (p.args.to as string)?.toLowerCase?.() || "";
              const amountStr =
                p.args.amount?.toString?.() ?? String(p.args.amount);
              const prevSweep = BigInt(surveys[addr]?.prizeSwept || "0");
              surveys[addr] = {
                ...(surveys[addr] || {}),
                prizeSwept: (prevSweep + BigInt(amountStr)).toString(),
              };
              appendLedger({
                t: "PrizeSwept",
                survey: addr,
                to: toAddr,
                amount: amountStr,
                block: l.blockNumber,
                tx: l.transactionHash,
              });
            }
          } catch {
            // ignore parse errors on non-matching logs
          }
        }
      }
    }
  }

  // -------- Off-chain Treasury funding verification (Safe)
  // User puts small JSON files into public/api/funding/<CHAIN_ID>/*.json with { survey, txHash }
  // We verify: tx.to == TREASURY_SAFE, tx.from == survey.creator, tx.value >= plannedRewardWei, confirmations >= MIN_CONF
  if (TREASURY_SAFE) {
    const subs = readFundingSubmissions(); // array of { survey, txHash }
    for (const sub of subs) {
      const sAddr = sub.survey.toLowerCase();
      const rec = surveys[sAddr];
      if (!rec) continue;
      if (rec.funded) continue; // already funded

      const plannedWei = BigInt(rec.plannedRewardWei || "0");
      if (plannedWei === 0n) continue; // nothing to fund

      try {
        const tx = await provider.getTransaction(sub.txHash);
        if (!tx) continue; // unknown tx
        // Require receipt and confirmations
        const receipt = await provider.getTransactionReceipt(sub.txHash);
        if (!receipt || receipt.status !== 1) continue;
        const conf = latest - Number(receipt.blockNumber) + 1;
        if (conf < MIN_CONF) continue;

        const toAddr = (tx.to || "").toLowerCase();
        const fromAddr = (tx.from || "").toLowerCase();
        const value = BigInt(String(tx.value || "0"));

        if (
          toAddr === TREASURY_SAFE &&
          fromAddr === (rec.creator || "").toLowerCase() &&
          value >= plannedWei
        ) {
          // Mark funded
          rec.funded = true;
          rec.fundingTxHash = sub.txHash;

          appendLedger({
            t: "TreasuryFunded",
            survey: sAddr,
            from: fromAddr,
            to: toAddr,
            amount: value.toString(),
            planned: plannedWei.toString(),
            tx: sub.txHash,
            confirmed: conf,
          });
        }
      } catch {
        // ignore invalid tx
      }
    }
  }

  // -------- Refresh live ETH balance for each survey (ground truth for on-chain pool)
  for (const sAddr of Object.keys(surveys)) {
    try {
      const bal = await provider.getBalance(sAddr);
      surveys[sAddr].prizeLiveBalance = bal.toString();
    } catch {
      /* ignore provider hiccups */
    }
  }

  // ===== Save artifacts =====
  fs.writeFileSync(FILES.BAL, JSON.stringify(balances, null, 2));
  fs.writeFileSync(FILES.SURV, JSON.stringify(surveys, null, 2));

  // Flat list for the frontend (stable shape)
  const list = Object.entries(surveys).map(([address, s]) => ({
    address,
    creator: s.creator,
    startTime: s.start,
    endTime: s.end,
    metaHash: s.metaHash,
    surveyType: s.surveyType ?? 0,

    // added for UX:
    title: s.title ?? "Untitled",
    plannedRewardEth: s.plannedRewardEth ?? "0",
    plannedRewardWei: s.plannedRewardWei ?? "0",
    metaValid: !!s.metaValid,
    metaUrl: s.metaUrl,

    // on-chain prize (if used):
    prizeFunded: s.prizeFunded || "0",
    prizeSwept: s.prizeSwept || "0",
    prizeLiveBalance: s.prizeLiveBalance || undefined,

    // off-chain treasury funding:
    funded: s.funded ?? false,
    fundingTxHash: s.fundingTxHash ?? null,
  }));
  fs.writeFileSync(FILES.LIST, JSON.stringify(list, null, 2));

  // Richer state.json
  fs.writeFileSync(
    FILES.STATE,
    JSON.stringify(
      {
        network: "zkSync Era Sepolia",
        chainId: CHAIN_ID,
        factoryAddress: FACTORY,
        treasurySafe: TREASURY_SAFE || null,
        lastBlock: toBlock,
        updatedAt: Math.floor(Date.now() / 1000),
        allowlist: [],
      },
      null,
      2
    )
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
