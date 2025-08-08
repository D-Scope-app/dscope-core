import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-ethers";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  zksolc: {
    version: "1.5.15",
    compilerSource: "binary",
    settings: {
      optimizer: {
        enabled: true,
      },
      codegen: "evmla",
    },
  },
  defaultNetwork: "zkSyncTestnet",

  networks: {
    zkSyncTestnet: {
      url: process.env.ZKSYNC_RPC || "",
      ethNetwork: "sepolia",
      zksync: true,
      verifyURL: "https://zksync2-testnet-explorer.zksync.dev/tx/",
      accounts: [process.env.WALLET_PRIVATE_KEY || ""],
    },
  },
  solidity: {
    version: "0.8.20",
  },
};

export default config;
