import { expect } from "chai";
import { Deployer } from "@matterlabs/hardhat-zksync-deploy";
import * as hre from "hardhat";
import * as dotenv from "dotenv";
import { Wallet, Provider } from "zksync-ethers";

dotenv.config();

describe("Greeter contract", function () {
  this.timeout(80000);
  it("Should return the new greeting once it's changed", async function () {
    const provider = new Provider(hre.network.config.url); // берём URL из hardhat.config.ts
    const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

    const deployer = new Deployer(hre, wallet);
    const artifact = await deployer.loadArtifact("Greeter");

    // Деплой контракта с начальным greeting
    const greeter = await deployer.deploy(artifact, ["Hello from zkSync!"]);

    // Проверка начального greeting
    expect(await greeter.greet()).to.equal("Hello from zkSync!");

    // Отправляем транзакцию и ждём подтверждения
    const tx = await greeter.setGreeting("New greeting from test");
    await tx.wait();

    // Проверяем обновлённое значение
    expect(await greeter.greet()).to.equal("New greeting from test");
  });
});
