import fs from "fs";
import { ethers } from "ethers";

const RPC = "https://subnets.avax.network/defi-kingdoms/dfk-chain/rpc";
const PROFILE_CONTRACT = "0xC4cD8C09D1A90b21Be417be91A81603B03993E81";

const provider = new ethers.JsonRpcProvider(RPC);

const abi = [
  "function getName(address user) view returns (string)"
];

const contract = new ethers.Contract(PROFILE_CONTRACT, abi, provider);

// Load leaderboard
const leaderboardPath = "./public/leaderboard.json";
const leaderboard = JSON.parse(fs.readFileSync(leaderboardPath));

const wallets = [...new Set(leaderboard.wins.map(w => w.wallet.toLowerCase()))];

console.log("Loaded wallets:", wallets.length);

const profiles = {};

for (const wallet of wallets) {
  try {
    const name = await contract.getName(wallet);

    if (name && name.trim() !== "") {
      profiles[wallet] = name;
      console.log("Resolved:", wallet, "→", name);
    }
  } catch (err) {
    // Most wallets won't have profiles. That's fine.
  }
}

fs.writeFileSync("./public/profiles.json", JSON.stringify(profiles, null, 2));

console.log("Done. Resolved:", Object.keys(profiles).length);