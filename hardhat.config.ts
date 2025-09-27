// hardhat.config.ts
import "dotenv/config";
import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-verify";

const PRIVATE_KEY = process.env.PRIVATE_KEY ?? "";
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY ?? "";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.20",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },

  defaultNetwork: "scrollSepolia",

  networks: {
    scrollSepolia: {
      url: "https://sepolia-rpc.scroll.io",
      chainId: 534351,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },

  etherscan: {
    apiKey: ETHERSCAN_API_KEY,
    customChains: [
      {
        network: "scrollSepolia",
        chainId: 534351,
        urls: {
          apiURL: "https://api-sepolia.scrollscan.com/api",
          browserURL: "https://sepolia.scrollscan.com",
        },
      },
    ],
  },

  sourcify: { enabled: false },
};

export default config;
