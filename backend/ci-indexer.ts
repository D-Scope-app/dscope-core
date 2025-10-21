// backend/ci-indexer.ts
// @ts-nocheck

/**
 * D-Scope V1 indexer — single/multi factory, Gate/Predicates, ms→sec, backfill, computed status.
 *
 * ENV (обновлено под Scroll):
 *   SCROLL_RPC=https://sepolia-rpc.scroll.io          // новый ключ (приоритетный)
 *   RPC_URL=https://sepolia-rpc.scroll.io             // альтернативный
 *   ZKSYNC_RPC=...                                    // старый ключ (fallback, чтобы не ломать CI)
 *   FACTORY_ADDRESS=0x...
 *   # FACTORIES=0x...,0x...
 *   START_BLOCK=...
 *   ONLY_LAST_BLOCKS=0
 *   CHAIN_ID=534351
 *   TREASURY_SAFE=0x...
 *   MIN_CONFIRMATIONS=2
 *   GATE_ADDR=0x...
 *   OUTPUT_DIR=../dscope-api/api
 *
 *   # новое для автопуша в воркер:
 *   API_BASE=https://api.dscope.app
 *   ADMIN_TOKEN=<Bearer-токен, настроенный в воркере>
 */

import * as fs from "fs";
import * as path from "path";
import { config as dotenvConfig } from "dotenv";
// ↓↓↓ ZKSync Provider УБРАН; для Scroll используем стандартный ethers провайдер
// import { Provider } from "zksync-ethers";
import {
  Interface,
  keccak256,
  toUtf8Bytes,
  parseEther,
  Contract,
  JsonRpcProvider, // ← стандартный провайдер ethers для Scroll
} from "ethers";
import { SURVEY_FACTORY_ABI, SURVEY_ABI } from "./abi";

// Если Node < 18 — раскомментируй:
// // @ts-ignore
// import fetch from "node-fetch";

// ---------- Load .env ----------
const env1 = path.resolve(process.cwd(), ".env");
const env2 = path.resolve(__dirname, "../.env");
const envPath = fs.existsSync(env1) ? env1 : fs.existsSync(env2) ? env2 : null;
if (envPath) dotenvConfig({ path: envPath, override: true });

// ---------- Extra push-to-worker config ----------
const API_BASE = (process.env.API_BASE || "").replace(/\/+$/, ""); // например: https://api.dscope.app
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // Bearer-токен из настроек воркера

// ---------- Helpers ----------
function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function canonicalize(obj: any) {
  const keys = Object.keys(obj || {}).sort();
  const out: any = {};
  for (const k of keys) out[k] = obj[k];
  return JSON.stringify(out);
}
function toSec(x: any) {
  const n = Number(x || 0);
  return n > 2e10 ? Math.floor(n / 1000) : Math.floor(n);
}
const nowSec = () => Math.floor(Date.now() / 1000);

// predicates normalization
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
  if (raw?.age_bucket) {
    if (Array.isArray(raw.age_bucket.in))
      out.push({
        key: "age_bucket",
        op: "in",
        value: raw.age_bucket.in.map(Number),
      });
    if (raw.age_bucket.eq !== undefined)
      out.push({
        key: "age_bucket",
        op: "==",
        value: Number(raw.age_bucket.eq),
      });
  }
  if (raw?.gender) {
    if (Array.isArray(raw.gender.in))
      out.push({ key: "gender", op: "in", value: raw.gender.in.map(String) });
    if (raw.gender.eq !== undefined)
      out.push({ key: "gender", op: "==", value: String(raw.gender.eq) });
  }
  if (Array.isArray(raw?.country?.in))
    out.push({ key: "country", op: "in", value: raw.country.in.map(String) });
  if (Array.isArray(raw?.country?.not_in))
    out.push({
      key: "country",
      op: "not_in",
      value: raw.country.not_in.map(String),
    });
  if (Array.isArray(raw?.region?.in))
    out.push({ key: "region", op: "in", value: raw.region.in.map(String) });
  if (raw?.human !== undefined)
    out.push({ key: "human", op: "==", value: !!raw.human });
  if (Array.isArray(raw?.extra))
    for (const e of raw.extra)
      out.push({ key: String(e.key), op: String(e.op), value: e.value });

  return out;
}

// ---------- Config (обновлено под Scroll) ----------
const CHAIN_ID = Number(process.env.CHAIN_ID || 534351); // ← Scroll Sepolia
const RPC =
  process.env.SCROLL_RPC || // ← приоритетный ключ для Scroll
  process.env.RPC_URL ||
  process.env.ZKSYNC_RPC || // ← старый ключ как fallback
  ((hre.network?.config as any)?.url as string | undefined) ||
  "https://sepolia-rpc.scroll.io"; // ← дефолт для Scroll Sepolia

let FACTORY: string = (process.env.FACTORY_ADDRESS || process.env.FACTORY || "")
  .toLowerCase()
  .trim();
let FACTORIES: string[] = [];
if (process.env.FACTORIES) {
  FACTORIES = String(process.env.FACTORIES)
    .split(/[,\s]+/)
    .map((s) => s.toLowerCase())
    .filter(Boolean);
}
if (FACTORY && !FACTORIES.includes(FACTORY)) FACTORIES.unshift(FACTORY);

// Fallback к deployments (обновлён: сначала scroll, потом старый zksync)
function readDeployField(fileName: string, def: any) {
  return readJSON(path.resolve(process.cwd(), "deployments", fileName), def);
}
if (!FACTORY && FACTORIES.length === 0) {
  const depScroll = readDeployField("scrollSepolia.json", null as any);
  const depZk = readDeployField("zkSyncSepolia.json", null as any); // совместимость
  const dep = depScroll || depZk;
  if (dep?.factory?.address)
    FACTORY = String(dep.factory.address).toLowerCase();
  if (FACTORY) FACTORIES.unshift(FACTORY);
}

const START =
  Number(process.env.START_BLOCK) ||
  Number(
    readDeployField("scrollSepolia.json", { factory: { deployBlock: 0 } })
      ?.factory?.deployBlock ??
      readDeployField("zkSyncSepolia.json", { factory: { deployBlock: 0 } })
        ?.factory?.deployBlock ??
      0
  );

const ONLY_LAST = Number(process.env.ONLY_LAST_BLOCKS || 0);

const TREASURY_SAFE = String(process.env.TREASURY_SAFE || "").toLowerCase();
const MIN_CONF = Number(
  process.env.MIN_CONFIRMATIONS || process.env.MIN_CONF || 2
);
const GATE_ADDR_HINT = (process.env.GATE_ADDR || "").toLowerCase();

const OUTPUT_DIR =
  process.env.OUTPUT_DIR && process.env.OUTPUT_DIR.trim()
    ? path.resolve(process.cwd(), process.env.OUTPUT_DIR.trim())
    : path.resolve(process.cwd(), "../dscope-api/api");

console.log("[Indexer] Config", {
  RPC,
  CHAIN_ID,
  FACTORY,
  FACTORIES,
  START_BLOCK: START,
  ONLY_LAST_BLOCKS: ONLY_LAST,
  TREASURY_SAFE,
  MIN_CONF,
  GATE_ADDR_HINT,
  OUTPUT_DIR,
  API_BASE,
});
if (!FACTORY && FACTORIES.length === 0)
  throw new Error(
    "FACTORY_ADDRESS/FACTORY is required in .env (or FACTORIES)."
  );

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

// ---------- Meta enrich ----------
function readLocalMeta(surveyAddr: string) {
  const localPath = path.join(metaDir, `${surveyAddr}.json`);
  const base = {
    meta: null,
    metaValid: false,
    title: "Untitled",
    summary: "",
    image: "",
    plannedRewardEth: "0",
    plannedRewardWei: "0",
    metaUrl: `/api/meta/${CHAIN_ID}/${surveyAddr}.json`,
    gateAddr: "",
    predicatesRaw: null as any,
    epoch: undefined as string | undefined,
  };
  if (!fs.existsSync(localPath)) return base;
  try {
    const meta = JSON.parse(fs.readFileSync(localPath, "utf8"));
    const plannedRewardEth = (meta?.plannedReward ?? "0").toString();
    let plannedRewardWei = "0";
    try {
      plannedRewardWei = parseEther(plannedRewardEth).toString();
    } catch {}
    return {
      meta,
      metaValid: false,
      title: (meta?.title ?? "Untitled").toString(),
      summary: (meta?.summary ?? "").toString(),
      image: (meta?.image ?? "").toString(),
      plannedRewardEth,
      plannedRewardWei,
      metaUrl: `/api/meta/${CHAIN_ID}/${surveyAddr}.json`,
      gateAddr: (meta?.gate?.addr ?? meta?.gateAddr ?? "").toString(),
      predicatesRaw: meta?.predicates ?? meta?.gate?.predicates ?? null,
      epoch: meta?.gate?.epoch ? String(meta.gate.epoch) : undefined,
    };
  } catch {
    return base;
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
  startSec?: number | null,
  endSec?: number | null,
  finalizedSec?: number | null,
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

// ---------- Push helpers (Worker Admin API) ----------
async function httpPostJSON(
  url: string,
  body: any,
  hdr: Record<string, string> = {}
) {
  const res = await (globalThis.fetch as any)(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...hdr,
    },
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
    `${API_BASE}/api/admin/meta.put`,
    {
      chainId,
      survey: addr,
      meta,
    },
    { authorization: `Bearer ${ADMIN_TOKEN}` }
  );
}

async function pushCardToWorker(card: any) {
  if (!API_BASE || !ADMIN_TOKEN || !card) return;

  const base = API_BASE.replace(/\/+$/, "");
  const url = /\/api$/i.test(base)
    ? `${base}/admin/list.upsert`
    : `${base}/api/admin/list.upsert`;

  await httpPostJSON(url, card, {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pushAllToWorker(
  list: any[],
  metaDirAbs: string,
  chainId: number
) {
  if (!API_BASE || !ADMIN_TOKEN) {
    console.log("[Push] Skipped: API_BASE/ADMIN_TOKEN not set");
    return;
  }
  console.log(`[Push] Start: ${list.length} items -> ${API_BASE}`);

  for (const card of list) {
    const addr = String(card.address || "").toLowerCase();
    const metaPath = path.join(metaDirAbs, `${addr}.json`);
    let meta: any = null;
    try {
      if (fs.existsSync(metaPath))
        meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch {}

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        if (meta) await pushMetaToWorker(addr, chainId, meta);
        await pushCardToWorker(card);
        break;
      } catch (e: any) {
        const msg = e?.message || String(e);
        const last = attempt === 3;
        console.warn(
          `[Push] ${addr} attempt ${attempt}/3 failed: ${msg}${
            last ? " (giving up)" : ""
          }`
        );
        if (last) break;
        await sleep(500 * attempt);
      }
    }
    await sleep(120);
  }

  console.log("[Push] Done.");
}

// ---------- Main ----------
(async () => {
  ensureOutputs();

  const iF = new Interface(SURVEY_FACTORY_ABI as any);
  const iS = new Interface(SURVEY_ABI as any);

  // ↓↓↓ заменили провайдер на ethers.JsonRpcProvider (Scroll)
  const provider = new JsonRpcProvider(RPC);
  const state = readJSON(FILES.STATE, { lastBlock: 0 });
  const latest = await provider.getBlockNumber();

  const fromByState = Number(state.lastBlock || 0) + 1;
  const fromByStart = Math.max(Number(START) || 0, 0);
  const fromByTail = ONLY_LAST ? Math.max(latest - ONLY_LAST + 1, 0) : 0;
  const fromBlock = Math.max(fromByState, fromByStart, fromByTail);
  const toBlock = latest;

  if (fromBlock > toBlock) {
    console.log(`[Indexer] No new blocks. last=${state.lastBlock}`);
    console.log(`[Indexer] Scan: ${fromBlock} → ${toBlock}`);
    // даже если нет новых — перезаписываем state/gates для консистентности
  } else {
    console.log(`[Indexer] Scan: ${fromBlock} → ${toBlock}`);
  }

  const balances: Record<string, number> = readJSON(FILES.BAL, {});
  const surveys: Record<string, any> = readJSON(FILES.SURV, {});
  const knownSurveyAddrs = new Set(
    Object.keys(surveys).map((a) => a.toLowerCase())
  );

  // Размер шагов — адресная фильтрация позволяет безопасно увеличить
  const BATCH = 1000;
  const CHUNK = 50;

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

  // -------- Pass 1: сканируем только логи фабрик (строго по адресам!)
  if (fromBlock <= toBlock && FACTORIES.length) {
    for (let f = fromBlock; f <= toBlock; f += BATCH) {
      const t = Math.min(f + BATCH - 1, toBlock);

      let logs: any[] = [];
      try {
        logs = await provider.getLogs({
          fromBlock: f,
          toBlock: t,
          address: FACTORIES as any,
        });
      } catch {
        // провайдер мог не принять массив адресов — обходим по одному
        logs = [];
        for (const fa of FACTORIES) {
          try {
            const part = await provider.getLogs({
              fromBlock: f,
              toBlock: t,
              address: fa as any,
            });
            logs.push(...part);
          } catch {}
        }
      }

      for (const l of logs) {
        const addr = (l.address || "").toLowerCase();
        if (!FACTORIES.includes(addr)) continue;

        try {
          const p = iF.parseLog(l);
          if (p?.name === "SurveyDeployed" || p?.name === "SurveyCreated") {
            const survey = (p.args.survey as string).toLowerCase();
            const creator = (p.args.creator as string)?.toLowerCase?.() || "";
            const start = toSec(Number(p.args.startTime ?? p.args.start ?? 0));
            const end = toSec(Number(p.args.endTime ?? p.args.end ?? 0));
            const surveyType = Number(p.args.surveyType ?? 0);
            const metaHash = String(p.args.metaHash ?? "");
            const ts = await blockTs(l.blockNumber);

            surveys[survey] = {
              ...(surveys[survey] || {}),
              creator,
              start,
              end,
              metaHash,
              surveyType,
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
              block: l.blockNumber,
              ts,
              tx: l.transactionHash,
            });
          }
        } catch {}
      }
    }
  }

  // -------- Enrich with META (+ predicates/gate)
  for (const sAddr of Array.from(knownSurveyAddrs)) {
    const rec = surveys[sAddr] || (surveys[sAddr] = {});
    const {
      meta,
      metaValid,
      title,
      summary,
      image,
      plannedRewardEth,
      plannedRewardWei,
      metaUrl,
      gateAddr,
      predicatesRaw,
      epoch,
    } = readLocalMeta(sAddr);

    // validate metaHash
    let valid = metaValid;
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

    // gate/predicates
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

  // -------- Pass 2: скан логов по известным адресам опросов (строго адресно!)
  if (knownSurveyAddrs.size > 0 && fromBlock <= toBlock) {
    const addrs = Array.from(knownSurveyAddrs);

    for (let f = fromBlock; f <= toBlock; f += BATCH) {
      const t = Math.min(f + BATCH - 1, toBlock);

      for (let i = 0; i < addrs.length; i += CHUNK) {
        const chunk = addrs.slice(i, i + CHUNK);

        let logs: any[] = [];
        try {
          logs = await provider.getLogs({
            fromBlock: f,
            toBlock: t,
            address: chunk as any,
          });
        } catch {
          // НИКАКИХ запросов по всему чейну — только адресно
          logs = [];
          for (const a of chunk) {
            try {
              const part = await provider.getLogs({
                fromBlock: f,
                toBlock: t,
                address: a as any,
              });
              logs.push(...part);
            } catch {}
          }
        }

        for (const l of logs) {
          const addr = (l.address || "").toLowerCase();
          if (!knownSurveyAddrs.has(addr)) continue;

          try {
            const p = iS.parseLog(l);
            const ts = await blockTs(l.blockNumber);

            if (p?.name === "QuestionAdded") {
              appendLedger({
                t: "QuestionAdded",
                survey: addr,
                index: Number(p.args.index),
                text: String(p.args.text),
                block: l.blockNumber,
                ts,
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
                ts,
                tx: l.transactionHash,
              });
            }
            if (p?.name === "Finalized") {
              const rulesHash = p.args.rulesHash
                ? String(p.args.rulesHash)
                : undefined;
              const resultsHash = p.args.resultsHash
                ? String(p.args.resultsHash)
                : undefined;
              const claimOpenAt = p.args.claimOpenAt
                ? Number(p.args.claimOpenAt)
                : undefined;
              const claimDeadline = p.args.claimDeadline
                ? Number(p.args.claimDeadline)
                : undefined;

              surveys[addr] = {
                ...(surveys[addr] || {}),
                finalizedAt: ts,
                rulesHash,
                resultsHash,
                claimOpenAt: claimOpenAt ? toSec(claimOpenAt) : undefined,
                claimDeadline: claimDeadline ? toSec(claimDeadline) : undefined,
              };

              appendLedger({
                t: "Finalized",
                survey: addr,
                block: l.blockNumber,
                ts,
                tx: l.transactionHash,
                rulesHash,
                resultsHash,
                claimOpenAt,
                claimDeadline,
              });
            }
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
                ts,
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
                ts,
                tx: l.transactionHash,
              });
            }
          } catch {}
        }
      }
    }
  }

  // -------- Backfill start/end via getters if missing, normalize ms→sec
  for (const sAddr of Object.keys(surveys)) {
    const rec = surveys[sAddr] || {};
    const needsStart =
      !Number.isFinite(Number(rec.start)) || Number(rec.start) <= 0;
    const needsEnd = rec.end === undefined || rec.end === null;

    if (needsStart || needsEnd) {
      try {
        const c = new Contract(sAddr, SURVEY_ABI as any, provider);

        let st = 0,
          en = 0;
        if (typeof c.startTime === "function")
          st = Number(await c.startTime().catch(() => 0));
        else if (typeof c.start === "function")
          st = Number(await c.start().catch(() => 0));
        if (typeof c.endTime === "function")
          en = Number(await c.endTime().catch(() => 0));
        else if (typeof c.end === "function")
          en = Number(await c.end().catch(() => 0));
        surveys[sAddr].start = toSec(needsStart ? st : rec.start || 0);
        surveys[sAddr].end = toSec(needsEnd ? en : rec.end ?? 0);
        appendLedger({
          t: "BackfilledSchedule",
          survey: sAddr,
          start: surveys[sAddr].start,
          end: surveys[sAddr].end,
        });
      } catch {
        if (needsStart && surveys[sAddr].start === undefined)
          surveys[sAddr].start = 0;
        if (needsEnd && surveys[sAddr].end === undefined)
          surveys[sAddr].end = 0;
      }
    } else {
      surveys[sAddr].start = toSec(rec.start);
      surveys[sAddr].end = toSec(rec.end);
    }

    if (surveys[sAddr].createdAt)
      surveys[sAddr].createdAt = toSec(surveys[sAddr].createdAt);
    if (surveys[sAddr].finalizedAt)
      surveys[sAddr].finalizedAt = toSec(surveys[sAddr].finalizedAt);
    if (surveys[sAddr].claimOpenAt)
      surveys[sAddr].claimOpenAt = toSec(surveys[sAddr].claimOpenAt);
    if (surveys[sAddr].claimDeadline)
      surveys[sAddr].claimDeadline = toSec(surveys[sAddr].claimDeadline);
  }

  // -------- Off-chain treasury funding verification
  if (TREASURY_SAFE) {
    const subs = readFundingSubmissions();
    for (const sub of subs) {
      const sAddr = sub.survey.toLowerCase();
      const rec = surveys[sAddr];
      if (!rec) continue;
      if (rec.funded) continue;

      const plannedWei = BigInt(rec.plannedRewardWei || "0");
      if (plannedWei === 0n) continue;

      try {
        const tx = await provider.getTransaction(sub.txHash);
        const receipt = await provider.getTransactionReceipt(sub.txHash);
        if (!tx || !receipt || receipt.status !== 1) continue;
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
      } catch {}
    }
  }

  // -------- Refresh live ETH balance (best effort)
  for (const sAddr of Object.keys(surveys)) {
    try {
      surveys[sAddr].prizeLiveBalance = (
        await provider.getBalance(sAddr)
      ).toString();
    } catch {}
  }

  // ===== Save artifacts =====

  // 1) Full map (surveys.json)
  fs.writeFileSync(FILES.BAL, JSON.stringify(balances, null, 2));
  fs.writeFileSync(FILES.SURV, JSON.stringify(surveys, null, 2));

  // 2) Flat list with normalized seconds and computed status (surveys.list.json)
  const now = nowSec();
  const list = Object.entries(surveys).map(([address, s]) => {
    const createdSec = s.createdAt ? toSec(s.createdAt) : 0;
    const startSec = s.start ? toSec(s.start) : 0;
    const endSec = (s.end ?? 0) !== null ? toSec(s.end ?? 0) : 0;
    const finalizedSec = s.finalizedAt ? toSec(s.finalizedAt) : 0;
    const status = computeStatus(
      startSec || null,
      endSec || null,
      finalizedSec || null,
      now
    );

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
      rulesHash: s.rulesHash || undefined,
      resultsHash: s.resultsHash || undefined,
      claimOpenAt: s.claimOpenAt || undefined,
      claimDeadline: s.claimDeadline || undefined,
      gate: s.gate
        ? {
            addr: (s.gate.addr || "").toLowerCase(),
            predicates: s.gate.predicates || [],
            epoch: s.gate.epoch ?? undefined,
          }
        : undefined,
      chainId: CHAIN_ID, // ← полезно явно класть в лист
    };
  });
  fs.writeFileSync(FILES.LIST, JSON.stringify(list, null, 2));

  // 3) gates.json for EIP-712
  const gateAddrFromList =
    list.find((x) => x.gate?.addr)?.gate?.addr || GATE_ADDR_HINT || "";
  const eip712 = {
    domain: {
      name: "D-Scope Eligibility", // оставил без изменений (это не про Scroll)
      version: "1",
      chainId: CHAIN_ID,
      verifyingContract: gateAddrFromList,
    },
    types: {
      Eligibility: [
        { name: "user", type: "address" },
        { name: "survey", type: "address" },
        { name: "epoch", type: "uint256" },
      ],
    },
  };
  fs.writeFileSync(
    FILES.GATES,
    JSON.stringify({ eip712, updatedAt: now }, null, 2)
  );

  // 4) state.json (обновлено поле network и chainId)
  fs.writeFileSync(
    FILES.STATE,
    JSON.stringify(
      {
        network: "Scroll Sepolia",
        chainId: CHAIN_ID,
        factoryAddress: (FACTORIES[0] || FACTORY || "").toLowerCase(),
        ...(FACTORIES.length
          ? { factories: FACTORIES.map((a) => a.toLowerCase()) }
          : {}),
        treasurySafe: TREASURY_SAFE || null,
        lastBlock: toBlock,
        updatedAt: now,
        allowlist: [],
      },
      null,
      2
    )
  );

  // ----- NEW: push artifacts to Worker KV (optional, if API_BASE/ADMIN_TOKEN set)
  try {
    await pushAllToWorker(list, metaDir, CHAIN_ID);
  } catch (e: any) {
    console.warn("[Push] Failed:", e?.message || e);
  }

  console.log(`[Indexer] Done. → ${outDir}`);
  console.log(
    `[Indexer] lastBlock=${toBlock} | surveys=${
      Object.keys(surveys).length
    } | voters=${Object.keys(balances).length}`
  );
})().catch((e) => {
  console.error("[Indexer] Fatal:", e);
  process.exit(1);
});
