// scripts/probe-profile-contract.js
// Probes the DFK Profiles contract to discover how names are stored.

import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";

// 👇 Replace this with the wallet that previously showed "just have fun"
const TEST_WALLET = "0xefba6f4352a4c8162dd789ab3788d5e287ca80cb";

const provider = new ethers.JsonRpcProvider(RPC);

// We test multiple possible function shapes
const ABI = [
  "function getProfile(address) view returns (string)",
  "function profiles(address) view returns (uint256,string,uint256)",
  "function profiles(address) view returns (tuple(uint256 id,string name,uint256 created))",
  "function getName(address) view returns (string)",
  "function getUserProfile(address) view returns (string)"
];

async function main() {
  const contract = new ethers.Contract(CONTRACT, ABI, provider);

  console.log("Testing wallet:", TEST_WALLET);
  console.log("Contract:", CONTRACT);
  console.log("----");

  for (const fn of [
    "getProfile",
    "profiles",
    "getName",
    "getUserProfile"
  ]) {
    try {
      if (!contract[fn]) continue;

      const result = await contract[fn](TEST_WALLET);
      console.log(`Function: ${fn}`);
      console.log(result);
      console.log("----");
    } catch (err) {
      console.log(`Function ${fn} failed`);
      console.log("----");
    }
  }
}

main().catch(console.error);