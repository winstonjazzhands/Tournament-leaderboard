// scripts/resolve-profiles-from-events.js
// Resolves profile names by decoding logs directly (no ABI guesswork).

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";

// The only topic0 we observed from this contract:
const TOPIC0 =
  "0x2c1415cbda85739695d2c281e25308b9c194f40490b09151d6cdf3c1dffd435d";

// How far back to scan. Start with 2,000,000 blocks (fast + matches your tournament lookback vibe).
// If you later want "all time", increase it or set to latest and start at 0.
const LOOKBACK_BLOCKS = 2_000_000;

const ROOT = process.cwd();
const OUTPUT = path.join(ROOT, "public", "profiles.json");

const provider = new ethers.JsonRpcProvider(RPC);
const coder = ethers.AbiCoder.defaultAbiCoder();

function topicToAddress(topic) {
  // topic is 32-byte hex. Address is the last 20 bytes.
  const hex = topic.toLowerCase();
  if (!hex.startsWith("0x") || hex.length !== 66) return null;
  return "0x" + hex.slice(26); // drop 0x + 24 hex chars (12 bytes) = keep last 40 hex chars
}

function decodeName(dataHex) {
  // Most likely: single ABI-encoded string in data
  try {
    const [name] = coder.decode(["string"], dataHex);
    const cleaned = String(name ?? "").trim();
    return cleaned || null;
  } catch {
    return null;
  }
}

async function main() {
  const latest = await provider.getBlockNumber();
  const start = Math.max(0, latest - LOOKBACK_BLOCKS);

  console.log("Latest block:", latest);
  console.log("Scanning blocks:", start, "→", latest);
  console.log("Contract:", CONTRACT);
  console.log("Topic0:", TOPIC0);

  const logs = await provider.getLogs({
    address: CONTRACT,
    fromBlock: start,
    toBlock: latest,
    topics: [TOPIC0],
  });

  console.log("Matching logs found:", logs.length);

  const namesByAddress = {};

  for (const log of logs) {
    const userTopic = log.topics?.[1];
    const wallet = userTopic ? topicToAddress(userTopic) : null;
    const name = decodeName(log.data);

    if (!wallet) continue;

    if (name) {
      namesByAddress[wallet.toLowerCase()] = name;
    } else {
      // Keep the wallet key around if it emitted an event but name decode failed
      if (!(wallet.toLowerCase() in namesByAddress)) {
        namesByAddress[wallet.toLowerCase()] = null;
      }
    }
  }

  const nonNull = Object.values(namesByAddress).filter(Boolean).length;
  console.log("Unique wallets in events:", Object.keys(namesByAddress).length);
  console.log("Non-null names decoded:", nonNull);

  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "event-logs",
    rpc: RPC,
    profilesContract: CONTRACT,
    topic0: TOPIC0,
    lookbackBlocks: LOOKBACK_BLOCKS,
    namesByAddress,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log("Wrote", OUTPUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});