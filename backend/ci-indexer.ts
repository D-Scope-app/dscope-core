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

// ---------- Extra push-to-worker config ----------
const API_BASE = (process.env.API_BASE || "").replace(/\/+$/, "");
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

// ---------- Helpers ----------
function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function canonicalize(obj: any) {
  const sort = (v: any) =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === "object"
      ? Object.keys(v)
          .sort()
          .reduce((a: any, k: string) => ((a[k] = sort(v[k])), a), {})
      : v;
  return JSON.stringify(sort(obj));
}
function toSec(x: any) {
  const n = Number(x || 0);
  return n > 2e10 ? Math.floor(n / 1000) : Math.floor(n);
}
const nowSec = () => Math.floor(Date.now() / 1000);

type Predicate =
  | { key: "age" | "age_bucket"; op: ">=" | "<=" | "==" | "in"; value: any }
  | { key: "country" | "region"; op: "in" | "not_in"; value: string[] }
  | { key: "gender"; op: "in" | "=="; value: string | string[] }
  | { key: "human"; op: "=="; value: boolean }
  | { key: string; op: string; value: any };

type GateInfo = { addr: string; predicates: Predicate[]; epoch?: string };
type FundingSubmission = {
  survey: string;
  txHash: string;
  createdAt?: number;
  note?: string;
};

function normalizePredicates(raw: any): Predicate[] {
  if (!raw) return [];
  const out: Predicate[] = [];
  if (raw?.age) {
    if (raw.age.gte !== undefined)
      out.push({ key: "age", op: ">=", value: Number(raw.age.gte) });
    if (raw.age.lte !== undefined)
      out.push({ key: "age", op: "<=", value: Number(raw.age.lte) });
    if (raw.age.eq !== undefined)
      out.push({ key: "age", op: "==", value: Number(raw.age.eq) });
  }
  if (raw?.age_bucket?.in)
    out.push({
      key: "age_bucket",
      op: "in",
      value: raw.age_bucket.in.map(Number),
    });
  if (raw?.gender?.in)
    out.push({ key: "gender", op: "in", value: raw.gender.in.map(String) });
  if (raw?.country?.in)
    out.push({ key: "country", op: "in", value: raw.country.in.map(String) });
  if (raw?.region?.in)
    out.push({ key: "region", op: "in", value: raw.region.in.map(String) });
  if (raw?.human !== undefined)
    out.push({ key: "human", op: "==", value: !!raw.human });
  return out;
}

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
  API_BASE,
});

// ---------- Output files ----------
const outDir = OUTPUT_DIR;
const metaDir = path.join(outDir, "meta", String(CHAIN_ID));
const fundingDir = path.join(outDir, "funding", String(CHAIN_ID));

const FILES = {
  STATE: path.join(outDir, "state.json"),
  LEDGER: path.join(outDir, "ledger.ndjson"),
  BAL: path.join(outDir, "balances.json"),
  SURV: path.join(outDir, "surveys.json"),
  LIST: path.join(outDir, "surveys.list.json"),
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
  if (!fs.existsSync(FILES.SURV)) fs.writeFileSync(FILES.SURV, "{}");
  if (!fs.existsSync(FILES.LIST)) fs.writeFileSync(FILES.LIST, "[]");
}

const appendLedger = (o: any) =>
  fs.appendFileSync(FILES.LEDGER, JSON.stringify(o) + "\n");

async function fetchMetaFromWorker(surveyAddr: string, chainId: number) {
  const url = `${API_BASE}/meta/${chainId}/${surveyAddr}.json`;
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return null;
    const meta = await res.json();

    const plannedRewardEth = (meta?.plannedReward ?? "0").toString();
    let plannedRewardWei = "0";
    try {
      plannedRewardWei = parseEther(plannedRewardEth).toString();
    } catch {}

    // 🔑 Читаем gateAddr и predicatesRaw из meta
    const gateAddr = (meta?.gate?.addr ?? "").toString();
    const predicatesRaw = meta?.predicates ?? meta?.gate?.predicates ?? null;

    return {
      meta,
      metaValid: true,
      title: (meta?.title ?? "Untitled").toString(),
      summary: (meta?.summary ?? "").toString(),
      image: (meta?.image ?? "").toString(),
      plannedRewardEth,
      plannedRewardWei,
      metaUrl: `${API_BASE}/meta/${chainId}/${surveyAddr}.json`.trim(),
      gateAddr,          // ← возвращаем как часть metaResult
      predicatesRaw,     // ← возвращаем как часть metaResult
      epoch: meta?.gate?.epoch ? String(meta.gate.epoch) : undefined,
    };
  } catch (e) {
    console.warn(`Failed to fetch meta for ${surveyAddr}:`, e);
    return null;
  }
}
// ---------- Funding submissions ----------
function readFundingSubmissions(): FundingSubmission[] {
  const list: FundingSubmission[] = [];
  try {
    for (const f of fs
      .readdirSync(fundingDir)
      .filter((f) => f.endsWith(".json"))) {
      try {
        const j = JSON.parse(fs.readFileSync(path.join(fundingDir, f), "utf8"));
        if (j?.survey && j?.txHash) {
          list.push({
            survey: String(j.survey).toLowerCase(),
            txHash: String(j.txHash),
            createdAt: Number(j.createdAt || 0),
            note: j.note ? String(j.note) : undefined,
          });
        }
      } catch {}
    }
  } catch {}
  return list;
}

// ---------- Status computation ----------
function computeStatus(
  startSec?: number,
  endSec?: number,
  finalizedSec?: number,
  now = nowSec()
) {
  const s = startSec && startSec > 0 ? startSec : null;
  const e = endSec && endSec > 0 ? endSec : null;
  const f = finalizedSec && finalizedSec > 0 ? finalizedSec : null;
  if (f) return "past";
  if (e && now >= e) return "past";
  if (s && now < s) return "upcoming";
  return "active";
}

// ---------- Push helpers ----------
async function httpPostJSON(
  url: string,
  body: any,
  hdr: Record<string, string> = {}
) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...hdr },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`POST ${url} -> ${res.status} ${t}`);
  }
  try {
    return await res.json();
  } catch {
    return {};
  }
}

async function pushMetaToWorker(addr: string, chainId: number, meta: any) {
  if (!API_BASE || !ADMIN_TOKEN || !meta) return;
  await httpPostJSON(
    `${API_BASE}/admin/meta.put`,
    { chainId, survey: addr, meta },
    { authorization: `Bearer ${ADMIN_TOKEN}` }
  );
}

async function pushCardToWorker(card: any) {
  if (!API_BASE || !ADMIN_TOKEN || !card) return;
  const url = `${API_BASE}/admin/list.upsert`;
  await httpPostJSON(url, card, { Authorization: `Bearer ${ADMIN_TOKEN}` });
}

// ---------- Main ----------
(async () => {
  ensureOutputs();

  const iF = new Interface(SURVEY_FACTORY_ABI);
  const iS = new Interface(SURVEY_ABI);

  const provider = new JsonRpcProvider(RPC);
  const state = readJSON(FILES.STATE, { lastBlock: 0 });
  const latest = await provider.getBlockNumber();

  const fromByTail = ONLY_LAST_BLOCKS
    ? Math.max(latest - ONLY_LAST_BLOCKS + 1, 0)
    : 0;

  // Приоритет: ONLY_LAST_BLOCKS > START_BLOCK > state
  let fromBlock = fromByTail;
  if (!ONLY_LAST_BLOCKS) {
    const fromByStart = Math.max(Number(START_BLOCK) || 0, 0);
    const fromByState = Number(state.lastBlock || 0) + 1;
    fromBlock = Math.max(fromByStart, fromByState);
  }
  fromBlock = Math.max(fromBlock, 0);
  const toBlock = latest;

  console.log(`[Indexer] Scan: ${fromBlock} → ${toBlock}`);

  const balances: Record<string, number> = readJSON(FILES.BAL, {});
  const surveys: Record<string, any> = readJSON(FILES.SURV, {});
  const knownSurveyAddrs = new Set(
    Object.keys(surveys).map((a) => a.toLowerCase())
  );

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

  // -------- Pass 1: scan factory logs (single address) --------
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

            surveys[survey] = {
              ...(surveys[survey] || {}),
              creator,
              start,
              end,
              metaHash,
              surveyType,
              plannedRewardWei: initialValue,
              plannedRewardEth: plannedReward,
              funded: surveys[survey]?.funded ?? false,
              fundingTxHash: surveys[survey]?.fundingTxHash ?? null,
              createdAt: surveys[survey]?.createdAt || ts,
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

  // -------- Enrich with META --------
  for (const sAddr of Array.from(knownSurveyAddrs)) {
    const rec = surveys[sAddr] || (surveys[sAddr] = {});
    const metaResult = await fetchMetaFromWorker(sAddr, CHAIN_ID);
const {
  meta,
  metaValid: initialMetaValid,
  title,
  summary,
  image,
  plannedRewardEth,
  plannedRewardWei,
  metaUrl,
  gateAddr,          // ← теперь безопасно: поле есть в metaResult
  predicatesRaw,     // ← и это тоже
  epoch,
} = metaResult || {
  meta: null,
  metaValid: false,
  title: "Untitled",
  summary: "",
  image: "",
  plannedRewardEth: "0",
  plannedRewardWei: "0",
  metaUrl: `${API_BASE}/meta/${chainId}/${surveyAddr}.json`.trim(),
  gateAddr: "",
  predicatesRaw: null,
  epoch: undefined,
};
    
    let valid = initialMetaValid;
    if (meta && rec.metaHash) {
      try {
        const localCanon = canonicalize(meta);
        const localHash = keccak256(toUtf8Bytes(localCanon));
        valid =
          localHash.toLowerCase() === String(rec.metaHash || "").toLowerCase();
      } catch {
        valid = false;
      }
    }

    const normPreds = normalizePredicates(predicatesRaw);
    const gateAddrCandidate = (gateAddr || GATE_ADDR_HINT || "").toLowerCase();

    surveys[sAddr] = {
      ...rec,
      title,
      summary,
      image,
      plannedRewardEth,
      plannedRewardWei,
      metaValid: !!valid,
      metaUrl,
      ...(gateAddrCandidate || normPreds.length || epoch
        ? {
            gate: {
              addr: gateAddrCandidate,
              predicates: normPreds,
              epoch,
            } as GateInfo,
          }
        : {}),
    };
  }

  // -------- Save artifacts --------
  fs.writeFileSync(FILES.BAL, JSON.stringify(balances, null, 2));
  fs.writeFileSync(FILES.SURV, JSON.stringify(surveys, null, 2));

  const now = nowSec();
  const list = Object.entries(surveys).map(([address, s]) => {
    const createdSec = s.createdAt ? toSec(s.createdAt) : 0;
    const startSec = s.start ? toSec(s.start) : 0;
    const endSec = s.end ? toSec(s.end) : 0;
    const finalizedSec = s.finalizedAt ? toSec(s.finalizedAt) : 0;
    const status = computeStatus(startSec, endSec, finalizedSec, now);

    return {
      address: address.toLowerCase(),
      creator: (s.creator || "").toLowerCase(),
      startTime: startSec,
      endTime: endSec,
      createdSec,
      startSec,
      endSec,
      finalizedSec,
      status,
      metaHash: s.metaHash || "",
      surveyType: s.surveyType ?? 0,
      title: s.title ?? "Untitled",
      summary: s.summary ?? "",
      image: s.image ?? "",
      plannedRewardEth: s.plannedRewardEth ?? "0",
      plannedRewardWei: s.plannedRewardWei ?? "0",
      metaValid: !!s.metaValid,
      metaUrl: s.metaUrl,
      prizeFunded: s.prizeFunded || "0",
      prizeSwept: s.prizeSwept || "0",
      prizeLiveBalance: s.prizeLiveBalance || undefined,
      funded: s.funded ?? false,
      fundingTxHash: s.fundingTxHash ?? null,
      gate: s.gate
        ? {
            addr: (s.gate.addr || "").toLowerCase(),
            predicates: s.gate.predicates || [],
            epoch: s.gate.epoch ?? undefined,
          }
        : undefined,
      chainId: CHAIN_ID,
    };
  });
  fs.writeFileSync(FILES.LIST, JSON.stringify(list, null, 2));

  // gates.json
  const gateAddrFromList =
    list.find((x) => x.gate?.addr)?.gate?.addr || GATE_ADDR_HINT || "";
  const eip712 = {
    domain: {
      name: "DScopeEligibility",
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: gateAddrFromList,
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
    JSON.stringify({ eip712, updatedAt: now }, null, 2)
  );

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
        updatedAt: now,
      },
      null,
      2
    )
  );

  // Push FULL list to Worker (atomically)
if (API_BASE && ADMIN_TOKEN) {
  console.log(`[Push] Uploading full list of ${list.length} surveys to Worker...`);

  // 1. Сначала пушим все meta-файлы для валидных опросов
  for (const card of list) {
    if (!card.metaValid) continue; // не пушим невалидные
    try {
      // Получаем meta, как мы его уже прочитали ранее (из fetchMetaFromWorker)
      // Но чтобы не дублировать логику — читаем из локального surveys
      const surveyRecord = surveys[card.address.toLowerCase()];
      if (surveyRecord?.meta) {
        await pushMetaToWorker(card.address, CHAIN_ID, surveyRecord.meta);
        await new Promise((r) => setTimeout(r, 200)); // небольшая задержка
      }
    } catch (e) {
      console.warn(`[Push] Failed to push meta for ${card.address}:`, e);
    }
  }

  // 2. Потом атомарно заменяем ВЕСЬ surveys.list.json
  try {
    await httpPostJSON(
      `${API_BASE}/admin/list.replace`,
      list,
      { Authorization: `Bearer ${ADMIN_TOKEN}` }
    );
    console.log("[Push] ✅ Successfully replaced surveys.list.json on Worker");
  } catch (e) {
    console.error("[Push] ❌ Failed to replace list on Worker:", e);
  }
}

  console.log(`[Indexer] Done. Surveys: ${list.length}`);
})().catch((e) => {
  console.error("[Indexer] Fatal:", e);
  process.exit(1);
});
