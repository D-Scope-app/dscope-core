// scripts/validate-api.js
const fs = require("fs");
const path = require("path");

const API = path.resolve("public", "api");
const die = (m) => {
  console.error("✗", m);
  process.exit(1);
};
const ok = (m) => console.log("✓", m);
const warn = (m) => console.warn("! " + m);

function read(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function isSec(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 0 && n < 2e10;
}
function looksMs(x) {
  const n = Number(x);
  return Number.isFinite(n) && n > 2e10;
}
function isWeiStr(x) {
  return typeof x === "string" && /^\d+$/.test(x);
}
function isAddr(x) {
  return typeof x === "string" && /^0x[0-9a-f]{40}$/.test(x);
}
function lower(x) {
  return (x || "").toLowerCase();
}
function normTs(x) {
  if (looksMs(x)) return Math.floor(Number(x) / 1000);
  return Number(x || 0);
}
function classify(s, now) {
  const st = normTs(s.startTime ?? s.start ?? 0);
  const et = normTs(s.endTime ?? s.end ?? 0);
  if (et > 0) {
    if (now < st) return "upcoming";
    if (now <= et) return "active";
    return "past";
  }
  if (now < st) return "upcoming";
  return "active";
}

(function main() {
  if (!fs.existsSync(API)) die(`Не найдена папка ${API}`);

  const state = read(path.join(API, "state.json")) || die("state.json missing");
  if (state.chainId !== 300) die("state.chainId must be 300");
  if (!isAddr(lower(state.factoryAddress || "")))
    die("state.factoryAddress invalid/lowercase");
  if (!isSec(state.updatedAt)) die("state.updatedAt must be seconds");
  ok("state.json OK");

  const surveysMap = read(path.join(API, "surveys.json"), {});
  const listMaybe = read(path.join(API, "surveys.list.json"), null);
  let list = Array.isArray(listMaybe)
    ? listMaybe
    : listMaybe === null
    ? []
    : Object.entries(listMaybe).map(([addr, s]) => ({ address: addr, ...s }));
  ok(`surveys: map=${Object.keys(surveysMap).length} list=${list.length}`);

  const mapAddrs = new Set(Object.keys(surveysMap));
  const listAddrs = new Set(
    list.map((x) => lower(x.address || x.survey || ""))
  );
  for (const a of listAddrs)
    if (!mapAddrs.has(a)) warn(`в list есть, а в map нет: ${a}`);
  for (const a of mapAddrs)
    if (!listAddrs.has(a)) warn(`в map есть, а в list нет: ${a}`);

  // Проверки по каждому опросу
  let msHits = 0,
    badMeta = 0,
    badWei = 0,
    badGate = 0;
  const now = Math.floor(Date.now() / 1000);

  for (const [addr, rec] of Object.entries(surveysMap)) {
    if (!isAddr(addr))
      die(`surveys.json key не lowercase или не адрес: ${addr}`);
    if (!("start" in rec)) die(`нет поля start для ${addr}`);
    if (looksMs(rec.start)) {
      msHits++;
      warn(`start выглядит как миллисекунды у ${addr}: ${rec.start}`);
    }
    if (rec.end && looksMs(rec.end)) {
      msHits++;
      warn(`end выглядит как миллисекунды у ${addr}: ${rec.end}`);
    }
    if (!isSec(normTs(rec.start))) die(`start не секунды у ${addr}`);
    if (Number(rec.end || 0) !== 0 && !isSec(normTs(rec.end)))
      die(`end не секунды у ${addr}`);

    if (!rec.metaUrl) {
      badMeta++;
      warn(`metaUrl отсутствует у ${addr}`);
    }
    if (rec.plannedRewardWei && !isWeiStr(rec.plannedRewardWei)) {
      badWei++;
      warn(`plannedRewardWei не число-строка у ${addr}`);
    }
    if (rec.gate?.addr && !isAddr(lower(rec.gate.addr))) {
      badGate++;
      warn(`gate.addr invalid/lowercase у ${addr}`);
    }
  }
  if (!msHits) ok("временные метки выглядят как секунды (не мс)");
  if (!badMeta) ok("metaUrl присутствует везде");
  if (!badWei) ok("plannedRewardWei валиден везде");
  if (!badGate) ok("gate.addr валиден (если указан)");

  // Агрегированная сводка по статусам
  const classified = list.map((x) => ({
    address: lower(x.address || x.survey || ""),
    startTime: normTs(x.startTime ?? x.start ?? 0),
    endTime: normTs(x.endTime ?? x.end ?? 0),
  }));
  const counts = { active: 0, upcoming: 0, past: 0 };
  for (const s of classified) counts[classify(s, now)]++;
  console.log("Статусы по list:", counts);

  // Подсветим странные случаи: end=0, но старт давно прошёл (> 30 дней назад)
  const THIRTY_D = 30 * 24 * 60 * 60;
  const suspicious = classified.filter(
    (s) => s.endTime === 0 && s.startTime > 0 && now - s.startTime > THIRTY_D
  );
  if (suspicious.length) {
    warn(
      `Найдено ${suspicious.length} опросов с end=0 и очень старым start (возможно, должны быть past):`
    );
    suspicious
      .slice(0, 10)
      .forEach((s) => console.log("  -", s.address, "start:", s.startTime));
  }

  // gates.json
  const gates = read(path.join(API, "gates.json"), null);
  if (gates?.eip712?.domain) {
    const vc = lower(gates.eip712.domain.verifyingContract || "");
    if (vc && !isAddr(vc)) die("gates.json domain.verifyingContract invalid");
    if (gates.eip712.domain.chainId !== 300)
      die("gates.json chainId must be 300");
    ok("gates.json OK");
  } else {
    warn("gates.json отсутствует или без eip712.domain (не критично)");
  }

  console.log("Готово.");
})();
