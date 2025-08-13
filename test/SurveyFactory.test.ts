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

describe("SurveyFactory minimal on zkSync", function () {
  this.timeout(180_000);

  it("deploys Survey via Factory and sets fields", async () => {
    const zkProvider = new Provider(hre.network.config.url);
    const owner = new Wallet(process.env.WALLET_PRIVATE_KEY!, zkProvider);

    const FactoryArtifact = await hre.artifacts.readArtifact("SurveyFactory");
    const SurveyArtifact = await hre.artifacts.readArtifact("Survey");

    const FactoryFactory = new ContractFactory(
      FactoryArtifact.abi,
      FactoryArtifact.bytecode,
      owner
    );
    const factory = await FactoryFactory.deploy();
    await factory.waitForDeployment();
    const factoryAddr = await factory.getAddress();

    const now = Math.floor(Date.now() / 1000);
    const startTime = now + 10;
    const endTime = startTime + 3600;

    // В фабрику передаем строку (если в твоей фабрике внутри делается keccak256),
    // но сверяем на контракте bytes32.
    const metaHashUrl = "ipfs://bafy...meta.json";
    const metaHash32 = hre.ethers.keccak256(
      hre.ethers.toUtf8Bytes(metaHashUrl)
    );

    // Вызов createSurvey с factoryDeps (обязательно на zkSync)
    const ifaceFactory = new hre.ethers.Interface(FactoryArtifact.abi);
    const calldataCreate = ifaceFactory.encodeFunctionData("createSurvey", [
      0, // SurveyType.MULTIPLE_CHOICE
      startTime,
      endTime,
      metaHashUrl, // строка; внутри фабрики должно быть: bytes32 meta = keccak256(bytes(metaHashUrl))
    ]);

    const txCreate = await owner.sendTransaction({
      to: factoryAddr,
      data: calldataCreate,
      gasLimit: 8_000_000,
      customData: { factoryDeps: [SurveyArtifact.bytecode] },
    });
    const rcpt = await txCreate.wait();

    // Достаём адрес Survey из события
    let surveyAddr: string | undefined;
    for (const l of rcpt.logs) {
      try {
        const parsed = ifaceFactory.parseLog(l);
        if (parsed?.name === "SurveyDeployed") {
          surveyAddr = parsed.args?.survey as string;
          break;
        }
      } catch {}
    }
    expect(surveyAddr, "Survey address not found").to.match(
      /^0x[a-fA-F0-9]{40}$/
    );

    // Проверяем поля
    const survey = new ZkContract(surveyAddr!, SurveyArtifact.abi, owner);
    expect(await survey.creator()).to.equal(owner.address);
    expect(await survey.startTime()).to.equal(BigInt(startTime));
    expect(await survey.endTime()).to.equal(BigInt(endTime));
    expect(await survey.surveyType()).to.equal(0n);
    expect(await survey.metaHash()).to.equal(metaHash32); // сверяем bytes32, не строку

    // Счётчик фабрики
    const count = await factory.getSurveysCount();
    expect(count).to.equal(1n);
  });
});
