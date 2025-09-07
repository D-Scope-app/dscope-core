import * as hre from "hardhat";
import { Provider, Wallet } from "zksync-ethers";
import { Interface, Contract } from "ethers";
import * as dotenv from "dotenv";
dotenv.config();

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  fn: () => Promise<T>,
  label: string,
  tries = 4
): Promise<T> {
  let last: any;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      last = e;
      const txt = String(e?.message || e);

      if (
        /ECONNRESET|ETIMEDOUT|ENOTFOUND|socket hang up|failed to detect network/i.test(
          txt
        )
      ) {
        console.log(`[retry ${i}/${tries}] ${label}: ${txt}`);
        await sleep(1000 * i);
        continue;
      }
      throw e;
    }
  }
  throw last;
}

async function main() {
  const rpcFromHardhat = (hre.network?.config as any)?.url as
    | string
    | undefined;
  const RPC =
    rpcFromHardhat || process.env.RPC_URL || "https://sepolia.era.zksync.dev";
  const FACTORY = (process.env.FACTORY_ADDRESS || "").toLowerCase();
  const PK = process.env.WALLET_PRIVATE_KEY;

  if (!PK) throw new Error("WALLET_PRIVATE_KEY отсутствует в .env");
  if (!/^0x[a-fA-F0-9]{40}$/.test(FACTORY))
    throw new Error("FACTORY_ADDRESS отсутствует/некорректен в .env");

  console.log("[DevCreate] Using RPC:", RPC);
  console.log("[DevCreate] Factory:", FACTORY);

  const zk = new Provider(RPC);

  const latest = await withRetry(() => zk.getBlockNumber(), "getBlockNumber");
  console.log("[DevCreate] RPC ok. Latest block:", latest);

  const wallet = new Wallet(PK, zk);

  const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");
  const SurveyArtifact = await hre.artifacts.readArtifact("Survey");
  const iFactory = new Interface(FactoryArtifact.abi);

  const START_IN_SEC = 90;
  const DURATION_SEC = 10 * 60;
  const now = Math.floor(Date.now() / 1000);
  const startTime = now + START_IN_SEC;
  const endTime = startTime + DURATION_SEC;
  const surveyType = 0; // MULTIPLE_CHOICE
  const metaUrl = "ipfs://demo-meta.json";

  const data = iFactory.encodeFunctionData("createSurvey", [
    surveyType,
    startTime,
    endTime,
    metaUrl,
  ]);

  console.log("[DevCreate] Sending Factory.createSurvey...");
  const tx = await withRetry(
    () =>
      wallet.sendTransaction({
        to: FACTORY,
        data,
        gasLimit: 8_000_000,
        customData: { factoryDeps: [SurveyArtifact.bytecode] as any },
      }),
    "sendTransaction(createSurvey)"
  );

  const rcpt = await withRetry(() => tx.wait(), "tx.wait(createSurvey)");
  console.log("[DevCreate] Tx mined:", rcpt?.hash);

  let surveyAddr: string | null = null;
  for (const l of rcpt?.logs || []) {
    try {
      const p = iFactory.parseLog(l as any);
      if (p?.name === "SurveyDeployed") {
        surveyAddr = (p.args.survey as string).toLowerCase();
        break;
      }
    } catch {}
  }
  if (!surveyAddr) throw new Error("Survey address not found in logs");
  console.log("[DevCreate] Survey address:", surveyAddr);

  const survey = new Contract(surveyAddr, SurveyArtifact.abi, wallet);
  const qTx = await withRetry(
    () =>
      survey.addQuestion(
        "Do you like zkSync?",
        ["Yes", "No"],
        0 // SelectionType.SINGLE
      ),
    "survey.addQuestion"
  );
  await withRetry(() => qTx.wait(), "tx.wait(addQuestion)");
  console.log("[DevCreate] Question #1 added.");

  console.log("=== Done ===");
  console.log("Start:", new Date(startTime * 1000).toLocaleString());
  console.log("End  :", new Date(endTime * 1000).toLocaleString());
  console.log("Open survey page:  app/survey.html?address=" + surveyAddr);
  console.log("Open results page: app/results.html?address=" + surveyAddr);
}

main().catch((e) => {
  console.error("[DevCreate] Fatal:", e);
  process.exit(1);
});
