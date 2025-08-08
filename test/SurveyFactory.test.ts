import { expect } from "chai";
import { Wallet, Provider, ContractFactory } from "zksync-ethers";
import * as dotenv from "dotenv";
import * as hre from "hardhat";

dotenv.config();

describe("SurveyFactory with constructor deployment on zkSync", function () {
  this.timeout(180_000);

  let owner: Wallet;
  let voter1: Wallet;
  let voter2: Wallet;
  let zkProvider: Provider;

  let factory: any;

  before(async () => {
    zkProvider = new Provider(hre.network.config.url);
    owner = new Wallet(process.env.WALLET_PRIVATE_KEY!, zkProvider);

    // Генерация временных кошельков для голосующих
    voter1 = Wallet.createRandom().connect(zkProvider);
    voter2 = Wallet.createRandom().connect(zkProvider);

    // Пополнение баланса тестовых кошельков
    const fundAmount = hre.ethers.parseEther("0.005");
    await owner.sendTransaction({ to: voter1.address, value: fundAmount });
    await owner.sendTransaction({ to: voter2.address, value: fundAmount });

    // Загрузка артефактов
    const SurveyArtifact = await hre.artifacts.readArtifact("Survey");
    const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");

    // Деплой SurveyFactory
    const FactoryFactory = new ContractFactory(
      FactoryArtifact.abi,
      FactoryArtifact.bytecode,
      owner
    );
    factory = await FactoryFactory.deploy();
    await factory.waitForDeployment();
  });

  it("should deploy a Survey via new and allow voting", async () => {
    const question = "Which protocol do you trust the most?";
    const options = ["zkSync", "StarkNet", "Linea"];
    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 5;
    const endTime = startTime + 60;

    const tx = await factory.createSurvey(
      question,
      options,
      startTime,
      endTime,
      {
        value: hre.ethers.parseEther("0.01"),
      }
    );
    const receipt = await tx.wait();

    const event = receipt.logs.find(
      (log: any) => log.fragment?.name === "SurveyCreated"
    );
    const cloneAddress = event?.args?.surveyAddress;
    expect(typeof cloneAddress).to.equal("string");
    expect(cloneAddress).to.match(/^0x[a-fA-F0-9]{40}$/);

    const clone = await hre.ethers.getContractAt("Survey", cloneAddress, owner);

    expect(await clone.question()).to.equal(question);
    expect(await clone.startTime()).to.equal(BigInt(startTime));
    expect(await clone.endTime()).to.equal(BigInt(endTime));

    console.log("⏳ Ждём старта голосования...");
    await new Promise((resolve) => setTimeout(resolve, 6000));

    await clone.connect(voter1).vote(0);

    const optionText = await clone.options(0);
    const count = await clone.votes(0);
    expect(optionText).to.equal("zkSync");
    expect(count).to.equal(1n);
  });
});
