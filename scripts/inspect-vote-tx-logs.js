#!/usr/bin/env node
// scripts/inspect-vote-tx-logs.js
// Print full topics + decoded data words for a tx (useful for debugging vote mapping)
//
// Usage:
//   RPC_URL=... node scripts/inspect-vote-tx-logs.js 0x<txHash>

import { ethers } from "ethers";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push("0x" + data.slice(i, i + 64));
  return words;
}

function topicToMaybeAddress(topic) {
  if (topic?.startsWith("0x000000000000000000000000") && topic.length === 66) {
    try {
      return ethers.getAddress("0x" + topic.slice(26));
    } catch {
      return null;
    }
  }
  return null;
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL");
  const txHash = process.argv[2];
  if (!txHash || !txHash.startsWith("0x") || txHash.length !== 66) {
    throw new Error("Usage: node scripts/inspect-vote-tx-logs.js 0x<txHash>");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const receipt = await provider.getTransactionReceipt(txHash);
  if (!receipt) throw new Error("No receipt found (wrong chain or tx not mined?)");

  console.log("TX:", txHash);
  console.log("Block:", receipt.blockNumber);
  console.log("From:", receipt.from);
  console.log("To:", receipt.to);
  console.log("Log count:", receipt.logs.length);
  console.log("-----");

  receipt.logs.forEach((log, i) => {
    console.log(`#${i}`);
    console.log("  emitter:", log.address);
    console.log("  topic0:", log.topics[0]);
    console.log("  topics:", log.topics);
    for (let t = 1; t < log.topics.length; t++) {
      const addr = topicToMaybeAddress(log.topics[t]);
      if (addr) console.log(`  topic[${t}] as address:`, addr);
    }
    const words = splitWords(log.data);
    const asDec = words.map((w) => BigInt(w).toString());
    console.log("  dataWords(hex):", words);
    console.log("  dataWords(dec):", asDec);
    console.log("");
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
