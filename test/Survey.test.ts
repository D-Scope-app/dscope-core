import { expect } from "chai";
import * as hre from "hardhat";
import {
  Provider,
  Wallet,
  ContractFactory,
  Contract as ZkContract,
} from "zksync-ethers";
import dotenv from "dotenv";
dotenv.config();

async function waitUntilTs(p: Provider, targetTs: number, stepMs = 3000) {
  while (true) {
    const blk = await p.getBlock("latest");
    const now = Number(blk.timestamp);
    if (now >= targetTs) break;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

describe("Survey minimal flow", function () {
  this.timeout(300_000); // 5 минут на всякий

  it("Should allow adding one question, voting, and finalizing", async function () {
    const provider = new Provider(hre.network.config.url);
    const owner = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);
    const voter = Wallet.createRandom().connect(provider);

    // Газ для второго кошелька
    await (
      await owner.sendTransaction({
        to: voter.address,
        value: hre.ethers.parseEther("0.001"),
      })
    ).wait();

    const SurveyArtifact = await hre.artifacts.readArtifact("Survey");
    const SurveyFactory = new ContractFactory(
      SurveyArtifact.abi,
      SurveyArtifact.bytecode,
      owner
    );

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 45;
    const endTime = startTime + 120;

    // metaHash в контракте bytes32 => хэшируем строку
    const metaHashUrl = "ipfs://bafy...meta.json";
    const metaHash32 = hre.ethers.keccak256(
      hre.ethers.toUtf8Bytes(metaHashUrl)
    );

    const survey = await SurveyFactory.deploy(
      0,
      startTime,
      endTime,
      owner.address,
      metaHash32
    );
    await survey.waitForDeployment();

    const zkSurvey = new ZkContract(
      await survey.getAddress(),
      SurveyArtifact.abi,
      owner
    );

    // Вопрос
    await (
      await zkSurvey.addQuestion("Do you like zkSync?", ["Yes", "No"], 0)
    ).wait();

    // Ждём старта по L2-времени
    await waitUntilTs(provider as Provider, startTime + 2);

    // Голос
    await (await zkSurvey.connect(voter).vote([[0]])).wait();
    expect(await zkSurvey.getParticipantsCount()).to.equal(1n);

    // Ждём конца окна по L2-времени
    await waitUntilTs(provider as Provider, endTime + 2);

    // Финализация (два bytes32)
    const rulesHash = hre.ethers.encodeBytes32String("rules-v1");
    const resultsHash = hre.ethers.encodeBytes32String("results-v1");
    await (await zkSurvey.finalize(rulesHash, resultsHash)).wait();

    // Проверки
    expect(await zkSurvey.finalized()).to.equal(true);
    expect(await zkSurvey.surveyType()).to.equal(0n);
    expect(await zkSurvey.metaHash()).to.equal(metaHash32);
    expect(await zkSurvey.startTime()).to.equal(BigInt(startTime));
    expect(await zkSurvey.endTime()).to.equal(BigInt(endTime));
  });
});
