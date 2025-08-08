import { expect } from "chai";
import { Wallet, Provider } from "zksync-web3";
import { ethers } from "hardhat";
import * as dotenv from "dotenv";
dotenv.config();

describe("Greeter contract", function () {
  let greeter: any;

  before(async () => {
    const zkSyncProvider = new Provider(process.env.ZKSYNC_RPC as string);
    const wallet = new Wallet(process.env.WALLET_PRIVATE_KEY || "", provider);

    const Greeter = await ethers.getContractFactory("Greeter");
    greeter = await Greeter.connect(wallet).deploy("Hello from zkSync!");
    await greeter.deployed();
  });

  it("Should return the new greeting once it's changed", async () => {
    await greeter.setGreeting("Hi D-Scope!");
    expect(await greeter.greet()).to.equal("Hi D-Scope!");
  });
});
