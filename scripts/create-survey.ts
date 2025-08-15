// scripts/create-survey.ts
import hre from "hardhat";
import { Provider, Wallet, Contract } from "zksync-ethers";
import dotenv from "dotenv";
import { Interface } from "ethers";

dotenv.config();

async function main() {
  // 1) Провайдер + кошелёк
  const rpc = (hre.network.config as any).url || process.env.RPC || "";
  if (!rpc)
    throw new Error(
      "RPC url is empty (нет hre.network.config.url и нет .env RPC)"
    );
  const provider = new Provider(rpc);

  const pk = process.env.WALLET_PRIVATE_KEY;
  if (!pk) throw new Error("WALLET_PRIVATE_KEY is missing in .env");
  const wallet = new Wallet(pk, provider);

  // 2) Фабрика
  const factoryAddr = (
    process.env.FACTORY_ADDRESS ||
    process.env.FACTORY ||
    ""
  ).trim();
  if (!factoryAddr)
    throw new Error("FACTORY_ADDRESS/FACTORY is missing in .env");

  const facArtifact = await hre.artifacts.readArtifact("SurveyFactory");
  const factory = new Contract(factoryAddr, facArtifact.abi, wallet);

  // 3) Параметры опроса (откорректируй под свой конструктор)
  const now = Math.floor(Date.now() / 1000);
  const surveyType = 0; // enum под тебя
  const startTime = now + 60; // старт через 1 мин
  const endTime = startTime + 3600; // 1 час
  const metaHash = "0x" + "00".repeat(32); // bytes32-заглушка

  // 4) Находим подходящий метод
  const iface = new Interface(facArtifact.abi as any);
  const candidates = ["createSurvey", "deploySurvey", "create", "newSurvey"];
  let method: string | null = null;
  for (const name of candidates) {
    try {
      iface.getFunction(name);
      method = name;
      break;
    } catch {}
  }
  if (!method) {
    const fns = (iface.fragments as any[])
      .filter((f: any) => f.type === "function")
      .map((f: any) => f.format());
    console.log("Доступные функции фабрики:\n" + fns.join("\n"));
    throw new Error(
      "Не найден метод создания (createSurvey/deploySurvey/create/newSurvey)."
    );
  }

  // 5) Вызов (частый вариант сигнатуры)
  const tx = await (factory as any)[method](
    surveyType,
    startTime,
    endTime,
    metaHash
  );
  console.log("Create tx:", tx.hash);
  const receipt = await tx.wait();
  console.log("Mined in block:", receipt.blockNumber);

  // 6) Парсим события фабрики и ищем адрес нового Survey
  const factoryLogs = receipt.logs.filter(
    (l: any) =>
      typeof l.address === "string" &&
      l.address.toLowerCase() === factoryAddr.toLowerCase()
  );

  let printed = false;
  for (const log of factoryLogs) {
    try {
      const parsed: any = iface.parseLog(log);
      if (!parsed) continue;
      console.log("Factory event:", parsed.name);

      for (const k of ["survey", "proxy", "addr", "instance"]) {
        const v = parsed.args?.[k];
        if (typeof v === "string" && v.startsWith("0x") && v.length === 42) {
          console.log("New Survey address:", v);
          printed = true;
        }
      }
      const first = parsed.args?.[0];
      if (
        !printed &&
        typeof first === "string" &&
        first.startsWith("0x") &&
        first.length === 42
      ) {
        console.log("Guessed Survey address:", first);
        printed = true;
      }
    } catch (_) {
      // не распарсилось — ок
    }
  }

  console.log(
    "✅ Готово: опрос создан через фабрику. Теперь запускай индексатор."
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
