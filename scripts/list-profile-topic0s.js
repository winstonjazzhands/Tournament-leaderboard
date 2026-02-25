// scripts/list-profile-topic0s.js
// Lists unique topic0 values emitted by the profiles contract over a block range.
// Use this to discover other events like ProfileUpdated / NameChanged etc.

import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const PROFILES_CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";

const provider = new ethers.JsonRpcProvider(RPC);

// Adjust these if needed
const LOOKBACK = 2_000_000; // scan last N blocks
const CHUNK = 200_000;

async function main() {
  const latest = await provider.getBlockNumber();
  const start = Math.max(0, latest - LOOKBACK);

  console.log("Latest block:", latest);
  console.log("Scanning:", start, "→", latest);
  console.log("Contract:", PROFILES_CONTRACT);

  const set = new Set();

  let from = start;
  while (from <= latest) {
    const to = Math.min(from + CHUNK, latest);
    const logs = await provider.getLogs({
      address: PROFILES_CONTRACT,
      fromBlock: from,
      toBlock: to,
    });

    for (const l of logs) {
      if (l.topics && l.topics[0]) set.add(l.topics[0]);
    }

    console.log(`Scanned ${from} → ${to} | logs=${logs.length} | unique topic0=${set.size}`);
    from = to + 1;
  }

  console.log("\nUnique topic0 values:");
  [...set].sort().forEach((t) => console.log(t));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});