import { expect } from "chai";
import { Wallet, Provider, ContractFactory } from "zksync-ethers";
import * as hre from "hardhat";
import dotenv from "dotenv";
dotenv.config();

describe("Greeter contract", function () {
  it("Should return the new greeting once it's changed", async function () {
    const provider = new Provider(hre.network.config.url);
    const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY!, provider);

    const artifact = await hre.artifacts.readArtifact("Greeter");
    const greeterFactory = new ContractFactory(
      artifact.abi,
      artifact.bytecode,
      wallet
    );

    const greeter = await greeterFactory.deploy("Hello, world!");
    await greeter.waitForDeployment();

    expect(await greeter.greet()).to.equal("Hello, world!");

    const tx = await greeter.setGreeting("Hi zkSync!");
    await tx.wait();

    expect(await greeter.greet()).to.equal("Hi zkSync!");
  });
});
