// backend/attester-server.ts
// @ts-nocheck

/**
 * Лёгкий HTTP-сервис:
 * - POST /api/zkpass/submit       — принять результат TransGate, посчитать агрегаты, обновить analytics JSON, отдать "ok"
 * - POST /api/eligibility/sign    — подписать EIP-712 Eligibility(user,survey,nullifier,deadline,chainId)
 * - GET  /api/analytics/:survey   — отдать analytics JSON (для локального теста; в проде берётся из Pages)
 * - GET  /api/gates.json          — дать фронту домен/типы EIP-712 и справочные zkPass-константы
 * - SSE  /api/stream/:survey      — (опционально) лайв-стрим апдейтов для дашборда
 *
 * Хранение состояния:
 * - OUTPUT_DIR/analytics/<survey>.json         — аггрегированный срез для дашборда
 * - OUTPUT_DIR/seen/<survey>.json              — список nullifier'ов (для дедупликации)
 *
 * Безопасность/PII:
 * - PII не сохраняем: dob, countryCode и пр. — не пишутся на диск.
 * - Только агрегаты: age_bucket (свод в 5 корзин), region, kyc_ok.
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { ethers, TypedDataDomain, TypedDataField } from "ethers";

// ---- ENV
const PORT = Number(process.env.PORT || 8787);
const OUTPUT_DIR = path.resolve(
  process.cwd(),
  process.env.OUTPUT_DIR || "./out-api"
);
const CHAIN_ID = Number(process.env.CHAIN_ID || 534351);
const GATE_ADDR = String(process.env.GATE_ADDR || "").toLowerCase();
const ATTESTER_PRIVKEY = String(process.env.ATTESTER_PRIVKEY || "");
const K_ANONYMITY = Number(process.env.K_ANONYMITY || 5);

const ZKCONF = {
  appId: process.env.ZKPASS_APP_ID || "",
  schemas: {
    binanceDob: process.env.ZKPASS_SCHEMA_BINANCE_DOB || "",
    kucoinCountry: process.env.ZKPASS_SCHEMA_KUCOIN_REGION || "",
    kucoinKyc: process.env.ZKPASS_SCHEMA_KUCOIN_KYC || "",
  },
};

// ---- FS helpers
const anaDir = path.join(OUTPUT_DIR, "analytics");
const seenDir = path.join(OUTPUT_DIR, "seen");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(anaDir)) fs.mkdirSync(anaDir, { recursive: true });
if (!fs.existsSync(seenDir)) fs.mkdirSync(seenDir, { recursive: true });

function readJSON<T = any>(p: string, fallback: T): T {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(p: string, obj: any) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
const nowSec = () => Math.floor(Date.now() / 1000);

type AgeBucketKey = "18-25" | "26-30" | "31-40" | "41-50" | "51+";
function dobToAgeBucketKey(dobISO: string | undefined): AgeBucketKey | null {
  if (!dobISO || dobISO.length < 10) return null;
  const y = Number(dobISO.slice(0, 4));
  const m = Number(dobISO.slice(5, 7));
  const d = Number(dobISO.slice(8, 10));
  const birth = new Date(Date.UTC(y || 0, (m || 1) - 1, d || 1));
  if (!isFinite(birth.getTime())) return null;
  const age = Math.floor(
    (Date.now() - birth.getTime()) / (365.25 * 24 * 3600 * 1000)
  );
  if (age < 18) return null;
  if (age <= 25) return "18-25";
  if (age <= 30) return "26-30";
  if (age <= 40) return "31-40";
  if (age <= 50) return "41-50";
  return "51+";
}

const COUNTRY_REGION: Record<string, string> = (() => {
  const EEA = new Set([
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
    "IS",
    "LI",
    "NO",
  ]);
  return new Proxy(
    {},
    {
      get(_t, code: string) {
        const cc = String(code || "").toUpperCase();
        if (EEA.has(cc)) return "Europe";

        const americas = new Set([
          "US",
          "CA",
          "MX",
          "BR",
          "AR",
          "CL",
          "CO",
          "PE",
          "VE",
          "UY",
          "EC",
          "BO",
          "PY",
          "SR",
          "GY",
          "GF",
          "BZ",
          "CR",
          "CU",
          "DO",
          "GT",
          "HN",
          "JM",
          "NI",
          "PA",
          "PR",
          "SV",
          "TT",
        ]);
        const asia = new Set([
          "CN",
          "JP",
          "KR",
          "TW",
          "SG",
          "HK",
          "MY",
          "TH",
          "VN",
          "PH",
          "ID",
          "IN",
          "PK",
          "BD",
          "LK",
          "NP",
          "AE",
          "SA",
          "QA",
          "KW",
          "OM",
          "BH",
          "IL",
          "TR",
          "KZ",
        ]);
        const africa = new Set([
          "ZA",
          "NG",
          "EG",
          "KE",
          "MA",
          "DZ",
          "TN",
          "GH",
          "ET",
          "UG",
          "TZ",
          "SD",
          "SN",
          "CI",
          "CM",
          "AO",
          "ZM",
          "ZW",
          "MZ",
          "DZ",
        ]);
        const oce = new Set(["AU", "NZ", "FJ", "PG"]);
        if (americas.has(cc)) return "Americas";
        if (asia.has(cc)) return "Asia";
        if (africa.has(cc)) return "Africa";
        if (oce.has(cc)) return "Oceania";
        return "Other";
      },
    }
  ) as any;
})();

// ---- In-memory SSE subscribers
const sseSubs: Map<string /*survey*/, Set<express.Response>> = new Map();
function sseBroadcast(survey: string, payload: any) {
  const set = sseSubs.get(survey.toLowerCase());
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  for (const res of set) {
    try {
      res.write(data);
    } catch {}
  }
}

type Row = {
  region: string;
  country?: string;
  count: number;
  kycOk: number;
  ageBuckets: Partial<Record<AgeBucketKey, number>>;
  lat?: number;
  lng?: number;
};
type Analytics = {
  updatedAt: number;
  total: number;
  eligible: number;
  kycOk: number;
  rows: Row[];
};

function emptyAnalytics(): Analytics {
  return { updatedAt: nowSec(), total: 0, eligible: 0, kycOk: 0, rows: [] };
}

function hasSeenNullifier(survey: string, h: string): boolean {
  const p = path.join(seenDir, `${survey.toLowerCase()}.json`);
  const arr: string[] = readJSON(p, []);
  return arr.includes(h.toLowerCase());
}
function markNullifier(survey: string, h: string) {
  const p = path.join(seenDir, `${survey.toLowerCase()}.json`);
  const arr: string[] = readJSON(p, []);
  if (!arr.includes(h.toLowerCase())) {
    arr.push(h.toLowerCase());
    writeJSON(p, arr);
  }
}

function upsertAnalytics(
  survey: string,
  region: string,
  countryCode: string | null,
  ageKey: AgeBucketKey | null,
  passedKyc: boolean
) {
  const f = path.join(anaDir, `${survey.toLowerCase()}.json`);
  const A: Analytics = readJSON(f, emptyAnalytics());

  const key = (region || "Unknown") + "|" + (countryCode || "");
  let row = A.rows.find((r) => r.region + "|" + (r.country || "") === key);
  if (!row) {
    row = {
      region: region || "Unknown",
      country: countryCode || "",
      count: 0,
      kycOk: 0,
      ageBuckets: {},
    };
    A.rows.push(row);
  }
  row.count += 1;
  if (passedKyc) row.kycOk += 1;
  if (ageKey) row.ageBuckets[ageKey] = (row.ageBuckets[ageKey] || 0) + 1;

  A.total = A.rows.reduce((a, r) => a + r.count, 0);
  A.kycOk = A.rows.reduce((a, r) => a + r.kycOk, 0);
  A.eligible = A.total;
  A.updatedAt = nowSec();

  writeJSON(f, A);

  sseBroadcast(survey, {
    type: "append",
    row: {
      region: row.region,
      country: row.country,
      count: 1,
      kycOk: passedKyc ? 1 : 0,
      ageBuckets: ageKey ? { [ageKey]: 1 } : {},
    },
  });
}

const EIP712_DOMAIN: TypedDataDomain = {
  name: "DScopeEligibility",
  version: "1",
  chainId: CHAIN_ID,
  verifyingContract: GATE_ADDR,
};
const EIP712_TYPES: Record<string, TypedDataField[]> = {
  Eligibility: [
    { name: "user", type: "address" },
    { name: "survey", type: "address" },
    { name: "nullifier", type: "bytes32" },
    { name: "deadline", type: "uint256" },
    { name: "chainId", type: "uint256" },
  ],
};

function requireEnvReady() {
  if (!ATTESTER_PRIVKEY || ATTESTER_PRIVKEY.length < 64) {
    throw new Error("ATTESTER_PRIVKEY not set");
  }
  if (!ethers.isAddress(GATE_ADDR)) {
    throw new Error("Bad GATE_ADDR");
  }
}
const signer = (() => {
  if (!ATTESTER_PRIVKEY) return null;
  try {
    return new ethers.Wallet(ATTESTER_PRIVKEY);
  } catch {
    return null;
  }
})();

// ---- Server
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

app.post("/api/zkpass/submit", (req, res) => {
  try {
    const survey = String(req.body?.survey || "").toLowerCase();
    const schemaId = String(req.body?.schemaId || "");
    const data = req.body?.data || {};
    const field = data?.fieldAssets || data?.data?.fieldAssets || {};
    const nullifier = (
      data?.nullifierHash ||
      data?.data?.nullifierHash ||
      ""
    ).toLowerCase();

    if (!ethers.isAddress(survey))
      return res.status(400).json({ error: "bad survey" });
    if (!nullifier || !/^0x[0-9a-f]{64}$/.test(nullifier))
      return res.status(400).json({ error: "bad nullifier" });

    if (hasSeenNullifier(survey, nullifier)) {
      return res.json({ ok: true, deduped: true });
    }

    let ageKey: AgeBucketKey | null = null;
    let region: string | null = null;
    let countryCode: string | null = null;
    let kyc_ok = false;

    if (schemaId === ZKCONF.schemas.binanceDob) {
      const dob = String(
        field["data|birthday"] ?? field["birthday"] ?? field["dob"] ?? ""
      );
      ageKey = dobToAgeBucketKey(dob);
    }

    if (schemaId === ZKCONF.schemas.kucoinCountry) {
      const cc = String(
        field["data|countryCode"] ?? field["countryCode"] ?? ""
      ).toUpperCase();
      if (cc) {
        countryCode = cc;
        region = COUNTRY_REGION[cc];
      }
    }

    // KuCoin KYC preset
    if (schemaId === ZKCONF.schemas.kucoinKyc) {
      kyc_ok = true;
    }

    if (!ageKey && !region && !kyc_ok) {
      return res.status(400).json({ error: "no aggregates derived" });
    }

    markNullifier(survey, nullifier);

    upsertAnalytics(
      survey,
      region || "Unknown",
      countryCode || null,
      ageKey,
      kyc_ok
    );

    return res.json({ ok: true, ageBucket: ageKey, region, kyc_ok });
  } catch (e: any) {
    console.error("ingest error", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ------- EIP-712 подпись -------
//
// body: { user:"0x..", survey:"0x..", nullifier:"0x..", deadline: <unixSec> }
// return: { signature, domain, types }
//
app.post("/api/eligibility/sign", async (req, res) => {
  try {
    requireEnvReady();
    if (!signer) return res.status(500).json({ error: "signer not ready" });

    const user = String(req.body?.user || "").toLowerCase();
    const survey = String(req.body?.survey || "").toLowerCase();
    const nullifier = String(req.body?.nullifier || "").toLowerCase();
    const deadline = Number(req.body?.deadline || 0);

    if (!ethers.isAddress(user))
      return res.status(400).json({ error: "bad user" });
    if (!ethers.isAddress(survey))
      return res.status(400).json({ error: "bad survey" });
    if (!/^0x[0-9a-f]{64}$/.test(nullifier))
      return res.status(400).json({ error: "bad nullifier" });
    if (!(deadline > Math.floor(Date.now() / 1000)))
      return res.status(400).json({ error: "bad deadline" });

    const domain: TypedDataDomain = { ...EIP712_DOMAIN };

    if (req.body?.gate && ethers.isAddress(String(req.body.gate))) {
      domain.verifyingContract = String(req.body.gate).toLowerCase();
    }

    const value = {
      user,
      survey,
      nullifier,
      deadline,
      chainId: domain.chainId,
    };

    const signature = await signer.signTypedData(domain, EIP712_TYPES, value);

    return res.json({
      ok: true,
      signature,
      domain,
      types: EIP712_TYPES,
    });
  } catch (e: any) {
    console.error("sign error", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.get("/api/analytics/:survey", (req, res) => {
  const survey = String(req.params.survey || "").toLowerCase();
  const f = path.join(anaDir, `${survey}.json`);
  const data = readJSON(f, emptyAnalytics());
  res.json(data);
});

app.get("/api/gates.json", (req, res) => {
  res.json({
    updatedAt: nowSec(),
    eip712: {
      domain: EIP712_DOMAIN,
      types: EIP712_TYPES,
    },
    zkpass: ZKCONF,
    k_anonymity: K_ANONYMITY,
  });
});

app.get("/api/stream/:survey", (req, res) => {
  const survey = String(req.params.survey || "").toLowerCase();
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write("\n");
  let set = sseSubs.get(survey);
  if (!set) {
    set = new Set();
    sseSubs.set(survey, set);
  }
  set.add(res);
  req.on("close", () => {
    set!.delete(res);
  });
});

// ---- Start
app.listen(PORT, () => {
  console.log(`[attester] up on http://localhost:${PORT}`);
  console.log(`[attester] CHAIN_ID=${CHAIN_ID} GATE=${GATE_ADDR}`);
  console.log(`[attester] OUTPUT_DIR=${OUTPUT_DIR}`);
});
