import { expect } from "chai";
import * as hre from "hardhat";
import * as dotenv from "dotenv";
import { Wallet, Provider, ContractFactory } from "zksync-ethers";
import { ethers } from "ethers";
import { strict as assert } from "assert";

dotenv.config();

describe("Survey contract full flow (live testnet)", function () {
  this.timeout(300000);

  let wallet: Wallet;
  let provider: Provider;

  before(async () => {
    provider = new Provider(hre.network.config.url);
    wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);
  });

  const wait = async (seconds: number) => {
    console.log(`⏳ Ждём ${seconds} сек...`);
    return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  };

  const deploySurvey = async (
    question: string,
    options: string[],
    startTime: number,
    endTime: number,
    value: bigint
  ) => {
    const artifact = await hre.artifacts.readArtifact("Survey");
    const factory = new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      wallet
    );
    const survey = await factory.deploy(question, options, startTime, endTime, {
      value,
    });
    await survey.waitForDeployment();
    return survey;
  };

  it("Should allow creator to refund if no votes were cast", async () => {
    const now = (await provider.getBlock("latest")).timestamp;
    const start = now + 60;
    const end = now + 120;
    const value = ethers.parseEther("0.01");

    const survey = await deploySurvey(
      "Is this refundable?",
      ["Yes", "No"],
      start,
      end,
      value
    );

    console.log("Опрос без голосов. Ожидаем завершения голосования...");
    await wait(130);

    const finalizeTx = await survey.finalize();
    await finalizeTx.wait();

    console.log("Финализировали. Пробуем вернуть средства создателю...");
    const balanceBefore = await wallet.getBalance();

    const refundTx = await survey.refundCreator();
    const receipt = await refundTx.wait();

    let gasUsed: bigint = 0n;

    if (refundTx.gasPrice) {
      gasUsed =
        BigInt(receipt.gasUsed.toString()) *
        BigInt(refundTx.gasPrice.toString());
    } else {
      console.warn(
        "⚠️ gasPrice is undefined — skipping gas cost deduction from expectation."
      );
    }

    const balanceAfter = await wallet.getBalance();

    const expectedMin = balanceBefore + value - gasUsed;
    const tolerance = ethers.parseEther("0.001");

    assert(
      balanceAfter >= expectedMin - tolerance,
      `Balance after refund is less than expected: got ${balanceAfter}, expected at least ${
        expectedMin - tolerance
      }`
    );

    const rewardPool = await survey.rewardPool();
    assert.equal(
      BigInt(rewardPool),
      0n,
      "Reward pool should be empty after refund"
    );
  });
});
