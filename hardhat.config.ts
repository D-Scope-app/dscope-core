import "@matterlabs/hardhat-zksync-deploy";
import "@matterlabs/hardhat-zksync-solc";
import "@matterlabs/hardhat-zksync-ethers";
import "@matterlabs/hardhat-zksync-verify";
import { HardhatUserConfig } from "hardhat/config";
import * as dotenv from "dotenv";
dotenv.config();

const config: HardhatUserConfig = {
  zksolc: {
    version: "1.5.15",
    settings: {
      optimizer: {
        enabled: true,
        mode: "3",
        runs: 200,
      },
      codegen: "evmla",
    },
  },

  defaultNetwork: "zkSyncSepolia",
  networks: {
    zkSyncSepolia: {
      url: process.env.ZKSYNC_RPC || "https://sepolia.era.zksync.dev",
      ethNetwork: "sepolia",
      zksync: true,
      accounts: [process.env.WALLET_PRIVATE_KEY || ""],
      verifyURL:
        "https://explorer.sepolia.era.zksync.dev/contract_verification",
    },
  },
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
};

export default config;
