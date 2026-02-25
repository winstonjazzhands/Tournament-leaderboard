// scripts/probe-profile-events.js
// Prints all event signatures emitted by the profiles contract.

import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";

const provider = new ethers.JsonRpcProvider(RPC);

async function main() {
  const latest = await provider.getBlockNumber();

  console.log("Latest block:", latest);
  console.log("Scanning last 500,000 blocks for events...");

  const logs = await provider.getLogs({
    address: CONTRACT,
    fromBlock: latest - 500000,
    toBlock: latest
  });

  console.log("Found logs:", logs.length);

  const topics = new Set();
  for (const log of logs) {
    if (log.topics?.[0]) topics.add(log.topics[0]);
  }

  console.log("Unique event topic0 values:");
  for (const t of topics) {
    console.log(t);
  }
}

main().catch(console.error);