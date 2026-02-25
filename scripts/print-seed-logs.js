#!/usr/bin/env node
/**
 * Print all logs from a seed transaction in a readable way.
 *
 * Required env:
 *   RPC_URL
 *   SEED_TX
 *
 * Windows CMD:
 *   set RPC_URL=https://andromeda.metis.io/?owner=1088
 *   set SEED_TX=0x7c410f9faf35cae21b23d1ff35495237e82d500e5845e96fca361d71a9e78820
 *   node scripts/print-seed-logs.js
 */

import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
const SEED_TX = process.env.SEED_TX;

if (!RPC_URL) {
  console.error("❌ Missing RPC_URL");
  process.exit(1);
}
if (!SEED_TX) {
  console.error("❌ Missing SEED_TX");
  process.exit(1);
}

function decodeWords(hexData) {
  const clean = (hexData || "0x").startsWith("0x")
    ? hexData.slice(2)
    : hexData;
  if (!clean) return [];
  if (clean.length % 64 !== 0) return null;

  const out = [];
  for (let i = 0; i < clean.length; i += 64) {
    out.push(BigInt("0x" + clean.slice(i, i + 64)));
  }
  return out;
}

function plausibleLevel(n) {
  return Number.isFinite(n) && n >= 1 && n <= 200;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  console.log("RPC_URL:", RPC_URL);
  console.log("SEED_TX:", SEED_TX);
  console.log("");

  const receipt = await provider.getTransactionReceipt(SEED_TX);
  if (!receipt) {
    console.error("❌ Could not fetch receipt.");
    process.exit(1);
  }

  console.log("Block:", receipt.blockNumber);
  console.log("Total logs:", receipt.logs.length);
  console.log("------------------------------------------------------------");

  for (let i = 0; i < receipt.logs.length; i++) {
    const log = receipt.logs[i];

    console.log(`\nLog #${i}`);
    console.log("Address:", log.address);
    console.log("Topic0 :", log.topics?.[0] || "(none)");
    console.log("Topics :", log.topics?.length || 0);

    if (log.topics?.length > 1) {
      for (let t = 1; t < log.topics.length; t++) {
        try {
          const bi = BigInt(log.topics[t]);
          console.log(`  topic[${t}] (uint256) =`, bi.toString());
        } catch {
          console.log(`  topic[${t}] =`, log.topics[t]);
        }
      }
    }

    const words = decodeWords(log.data);
    if (!words) {
      console.log("Data: <non-32-byte-aligned>");
      continue;
    }

    if (words.length === 0) {
      console.log("Data: <empty>");
      continue;
    }

    console.log("Data words:", words.length);

    for (let w = 0; w < words.length; w++) {
      const bi = words[w];
      const asNum = Number(bi);

      let marker = "";

      if (plausibleLevel(asNum)) {
        marker += " [plausible-level]";
      }
      if (asNum === 10) marker += " [LEVEL_10]";
      if (asNum === 20) marker += " [LEVEL_20]";

      console.log(`  word[${w}] = ${bi.toString()}${marker}`);
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("ERROR:", e?.message || String(e));
  process.exit(1);
});