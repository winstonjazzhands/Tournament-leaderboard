// scripts/decode-profile-event.js
// Attempts to decode the profile event by trying common patterns.

import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";

const provider = new ethers.JsonRpcProvider(RPC);

const candidateABIs = [
  "event ProfileCreated(address indexed user, string name)",
  "event ProfileUpdated(address indexed user, string name)",
  "event ProfileSet(address indexed user, string name)",
  "event Profile(address indexed user, string name)",
  "event UserProfile(address indexed user, string name)",
  "event Profile(address indexed user, uint256 id, string name)",
  "event ProfileCreated(address indexed user, uint256 id, string name)"
];

async function main() {
  const latest = await provider.getBlockNumber();

  const logs = await provider.getLogs({
    address: CONTRACT,
    fromBlock: latest - 500000,
    toBlock: latest
  });

  if (!logs.length) {
    console.log("No logs found.");
    return;
  }

  console.log("Trying to decode", logs.length, "logs...\n");

  for (const abi of candidateABIs) {
    try {
      const iface = new ethers.Interface([abi]);

      for (const log of logs) {
        try {
          const parsed = iface.parseLog(log);
          console.log("SUCCESS with ABI:", abi);
          console.log(parsed);
          console.log("----");
          return;
        } catch {}
      }
    } catch {}
  }

  console.log("No ABI matched.");
}

main().catch(console.error);