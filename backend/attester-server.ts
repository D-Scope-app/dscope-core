// backend/attester-server.ts
// @ts-nocheck

/**
 * Лёгкий HTTP-сервис:
 * - POST /api/zkpass/submit        — принять результат TransGate, посчитать агрегаты (merge по nullifier), обновить analytics JSON, отдать "ok"
 * - POST /api/eligibility/sign     — подписать EIP-712 Eligibility(user,survey,nullifier,deadline,chainId)
 * - GET  /api/analytics/:survey(.json) — отдать analytics JSON
 * - GET  /api/gates.json           — дать фронту домен/типы EIP-712 и справочные zkPass-константы (+ k_anonymity)
 * - SSE  /api/stream/:survey       — лайв-стрим дельт для дашборда
 *
 * Хранение состояния (без PII):
 * - OUTPUT_DIR/analytics/<survey>.json   — агрегированный срез (только: ageBuckets, region, kycOk, totals)
 * - OUTPUT_DIR/people/<survey>.json      — «псевдо-персоны» (по nullifier) для мерджа шагов (без dob/countryCode)
 *
 * Политика PII:
 * - DOB / countryCode и любые первичные значения НЕ сохраняются.
 * - Только производные агрегаты: age_bucket, region, kyc_ok (и nullifier для мерджа).
 */

import "dotenv/config";
import fs from "fs";
import path from "path";
import express from "express";
import cors from "cors";
import bodyParser from "body-parser";
import { ethers, TypedDataDomain, TypedDataField } from "ethers";

// ===== ENV / CONFIG =====
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
    binanceDob:
      process.env.ZKPASS_SCHEMA_BINANCE_DOB ||
      "b6fd16b78d9f4eba93bc458c2bb05ae9",
    kucoinCountry:
      process.env.ZKPASS_SCHEMA_KUCOIN_REGION ||
      "65f20da81c7142459828d672c83daaa2",
    kucoinKyc:
      process.env.ZKPASS_SCHEMA_KUCOIN_KYC ||
      "848605696f0e45f9a4d9b9896e8d4269",
  },
};

// ===== FS helpers & dirs =====
const anaDir = path.join(OUTPUT_DIR, "analytics");
const pplDir = path.join(OUTPUT_DIR, "people");
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(anaDir)) fs.mkdirSync(anaDir, { recursive: true });
if (!fs.existsSync(pplDir)) fs.mkdirSync(pplDir, { recursive: true });

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

// ===== Types =====
type AgeBucketKey = "18-25" | "26-30" | "31-40" | "41-50" | "51+";
type Person = {
  nullifier: string; // bytes32 (hex, lowercased)
  ageBucket?: AgeBucketKey;
  region?: string; // Europe / Asia / Americas / Africa / Oceania / Other / Unknown
  country?: string; // ISO-2 (опционально, для геоточек/таблицы)
  kycOk?: boolean;
};
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

// ===== Bucket calc =====
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

// ===== Region map (countryCode → region) =====
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

// ===== SSE =====
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

// ===== Analytics helpers =====
function emptyAnalytics(): Analytics {
  return { updatedAt: nowSec(), total: 0, eligible: 0, kycOk: 0, rows: [] };
}
const pplPath = (s: string) => path.join(pplDir, `${s.toLowerCase()}.json`);
const anaPath = (s: string) => path.join(anaDir, `${s.toLowerCase()}.json`);
const loadPeople = (s: string) => readJSON<Person[]>(pplPath(s), []);
const savePeople = (s: string, arr: Person[]) => writeJSON(pplPath(s), arr);

function applyAggDeltas(
  survey: string,
  region: string,
  country: string,
  countDelta: number,
  kycDelta: number,
  ageDelta: Partial<Record<AgeBucketKey, number>>
) {
  const f = anaPath(survey);
  const A: Analytics = readJSON(f, emptyAnalytics());

  const key = (region || "Unknown") + "|" + (country || "");
  let row = A.rows.find(
    (r) => (r.region || "Unknown") + "|" + (r.country || "") === key
  );
  if (!row) {
    row = {
      region: region || "Unknown",
      country: country || "",
      count: 0,
      kycOk: 0,
      ageBuckets: {},
    };
    A.rows.push(row);
  }

  if (countDelta) row.count += countDelta;
  if (kycDelta) row.kycOk += kycDelta;
  for (const k of Object.keys(ageDelta || {}) as AgeBucketKey[]) {
    const v = Number(ageDelta[k] || 0);
    if (v) row.ageBuckets[k] = (row.ageBuckets[k] || 0) + v;
  }

  // totals
  A.total = A.rows.reduce((a, r) => a + r.count, 0);
  A.kycOk = A.rows.reduce((a, r) => a + r.kycOk, 0);
  A.eligible = A.total; // всё, что заингестили, считаем eligible
  A.updatedAt = nowSec();

  writeJSON(f, A);
  return A;
}

// ===== EIP-712 =====
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

// ===== Server =====
const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "1mb" }));

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---- ZKPass ingest (merge by nullifier; deltas only) ----
app.post("/api/zkpass/submit", (req, res) => {
  try {
    const survey = String(req.body?.survey || "").toLowerCase();
    const schemaId = String(req.body?.schemaId || "");
    const data = req.body?.data || {};
    const field = data?.fieldAssets || data?.data?.fieldAssets || {}; // поддержка обеих форм
    const nullifier = (
      data?.nullifierHash ||
      data?.data?.nullifierHash ||
      ""
    ).toLowerCase();

    if (!ethers.isAddress(survey)) {
      return res.status(400).json({ error: "bad survey" });
    }
    if (!/^0x[0-9a-f]{64}$/.test(nullifier)) {
      return res.status(400).json({ error: "bad nullifier" });
    }

    // --- derive aggregates from this proof step ---
    let derivedAge: AgeBucketKey | null = null;
    let derivedRegion: string | null = null;
    let derivedCountry: string | null = null;
    let derivedKyc = false;

    if (schemaId === ZKCONF.schemas.binanceDob) {
      const dob = String(
        field["data|birthday"] ?? field["birthday"] ?? field["dob"] ?? ""
      );
      // Никаких сохранений dob — только корзина!
      derivedAge = dobToAgeBucketKey(dob);
    }

    if (schemaId === ZKCONF.schemas.kucoinCountry) {
      const cc = String(
        field["data|countryCode"] ?? field["countryCode"] ?? ""
      ).toUpperCase();
      if (cc) {
        derivedCountry = cc;
        derivedRegion = COUNTRY_REGION[cc] || "Other";
      }
    }

    if (schemaId === ZKCONF.schemas.kucoinKyc) {
      derivedKyc = true;
    }

    // --- load/update person (merge) ---
    const people = loadPeople(survey);
    let person = people.find((p) => p.nullifier === nullifier);
    const firstTime = !person;
    if (!person) person = { nullifier };

    // Какие дельты реально применились?
    let countDelta = 0;
    let kycDelta = 0;
    const ageDelta: Partial<Record<AgeBucketKey, number>> = {};

    if (firstTime) {
      countDelta = 1;
    }

    // age
    if (derivedAge && person.ageBucket !== derivedAge) {
      person.ageBucket = derivedAge;
      ageDelta[derivedAge] = 1;
    }

    // region/country
    if (derivedRegion && person.region !== derivedRegion) {
      person.region = derivedRegion;
    }
    if (derivedCountry && person.country !== derivedCountry) {
      person.country = derivedCountry;
    }

    // kyc
    if (derivedKyc && !person.kycOk) {
      person.kycOk = true;
      kycDelta = 1;
    }

    // Если совсем ничего не изменилось — вернём deduped:true
    const nothingChanged =
      countDelta === 0 &&
      kycDelta === 0 &&
      Object.values(ageDelta).reduce((a, v) => a + (v || 0), 0) === 0 &&
      // region/country тоже не изменились (если пришли)
      (!derivedRegion || derivedRegion === (person.region || derivedRegion)) &&
      (!derivedCountry ||
        derivedCountry === (person.country || derivedCountry));

    // Сохраняем людей
    if (firstTime) people.push(person);
    savePeople(survey, people);

    // Если изменений нет — можно ответить "deduped"
    if (nothingChanged) {
      return res.json({
        ok: true,
        deduped: true,
        applied: {
          countDelta: 0,
          kycDelta: 0,
          ageDelta: {},
          region: person.region || "Unknown",
          country: person.country || "",
        },
      });
    }

    // --- apply deltas to analytics (region для строки — из person, а не из derived) ---
    const regionForRow = person.region || "Unknown";
    const countryForRow = person.country || "";
    const updated = applyAggDeltas(
      survey,
      regionForRow,
      countryForRow,
      countDelta,
      kycDelta,
      ageDelta
    );

    // --- SSE: шлём именно дельты ---
    sseBroadcast(survey, {
      type: "append",
      row: {
        region: regionForRow,
        country: countryForRow,
        count: countDelta,
        kycOk: kycDelta,
        ageBuckets: ageDelta,
      },
    });

    return res.json({
      ok: true,
      applied: {
        countDelta,
        kycDelta,
        ageDelta,
        region: regionForRow,
        country: countryForRow,
      },
      totals: {
        updatedAt: updated.updatedAt,
        total: updated.total,
        eligible: updated.eligible,
        kycOk: updated.kycOk,
      },
    });
  } catch (e: any) {
    console.error("ingest error", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- EIP-712 подпись ----
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

    // Разрешаем переопределить verifyingContract (как в фронте)
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

    return res.json({ ok: true, signature, domain, types: EIP712_TYPES });
  } catch (e: any) {
    console.error("sign error", e);
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

// ---- Analytics (с алиасом .json для фронта) ----
app.get(
  ["/api/analytics/:survey", "/api/analytics/:survey.json"],
  (req, res) => {
    const survey = String(req.params.survey || "").toLowerCase();
    const f = anaPath(survey);
    const data = readJSON(f, emptyAnalytics());
    res.json(data);
  }
);

// ---- Gates/config ----
app.get("/api/gates.json", (_req, res) => {
  res.json({
    updatedAt: nowSec(),
    eip712: { domain: EIP712_DOMAIN, types: EIP712_TYPES },
    zkpass: ZKCONF,
    k_anonymity: K_ANONYMITY,
  });
});

// ---- SSE (live) ----
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

// ---- Start ----
app.listen(PORT, () => {
  console.log(`[attester] up on http://localhost:${PORT}`);
  console.log(`[attester] CHAIN_ID=${CHAIN_ID} GATE=${GATE_ADDR || "(unset)"}`);
  console.log(`[attester] OUTPUT_DIR=${OUTPUT_DIR}`);
  console.log(`[attester] ZK schemas:`, ZKCONF.schemas);
});
