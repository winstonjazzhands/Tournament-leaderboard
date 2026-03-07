// scripts/build-boutKey-to-matchKey-by-tx.js
//
// Builds a mapping from vote "boutKey" (from vote event log data word w1)
// to matchKey (from match logs data word w3), by joining logs that appear
// in the SAME transaction (txHash).
//
// Usage:
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/build-boutKey-to-matchKey-by-tx.js 22000000 22320000
//
// Output:
//   public/boutKeyToMatchKey.json

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// Your vote/mapping event topic0 (you already discovered this)
const VOTE_TOPIC0 =
  "0x212d381b01f1e26324135ac9efbe6e1506536df18f511a42fba4c58f7d7af280";

// IMPORTANT: set this to the same match topic0 you already use in
// build-matchkey-to-tournamentId.js (copy that constant here).
// If you’re not sure, open that file and copy the MATCH_TOPIC0 value.
const MATCH_TOPIC0 = "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  console.error("Set RPC_URL first.");
  process.exit(1);
}

const fromBlock = Number(process.argv[2] || 22000000);
const toBlock = Number(process.argv[3] || 22320000);

function splitWords(hex) {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) out.push("0x" + chunk);
  }
  return out;
}

function u32(hexWord) {
  // Reads as BigInt; we’ll stringify
  return BigInt(hexWord).toString();
}

const provider = new ethers.JsonRpcProvider(rpcUrl);

console.log("Scanning blocks:", fromBlock, "->", toBlock);

// pull vote logs
const voteLogs = await provider.getLogs({
  address: DIAMOND,
  fromBlock,
  toBlock,
  topics: [VOTE_TOPIC0],
});
console.log("vote logs:", voteLogs.length);

// pull match logs
const matchLogs = await provider.getLogs({
  address: DIAMOND,
  fromBlock,
  toBlock,
  topics: [MATCH_TOPIC0],
});
console.log("match logs:", matchLogs.length);

// group by txHash
const byTx = new Map(); // tx -> { boutKeys:[], matchKeys:[] }

for (const l of voteLogs) {
  const words = splitWords(l.data);
  const boutKey = words[1] ? u32(words[1]) : null; // data:w1
  if (!boutKey) continue;
  const tx = l.transactionHash;
  if (!byTx.has(tx)) byTx.set(tx, { boutKeys: [], matchKeys: [] });
  byTx.get(tx).boutKeys.push(boutKey);
}

for (const l of matchLogs) {
  const words = splitWords(l.data);
  const matchKey = words[3] ? u32(words[3]) : null; // matchKey word index = 3 (your latest inference)
  if (!matchKey) continue;
  const tx = l.transactionHash;
  if (!byTx.has(tx)) byTx.set(tx, { boutKeys: [], matchKeys: [] });
  byTx.get(tx).matchKeys.push(matchKey);
}

// build mapping only where it’s unambiguous
const map = {}; // boutKey -> matchKey
let kept = 0;
let skipped = 0;

for (const [tx, obj] of byTx.entries()) {
  // we only accept simple cases:
  // - exactly one matchKey in tx
  // - one or more boutKeys in tx
  const uniqMatch = [...new Set(obj.matchKeys)];
  const uniqBout = [...new Set(obj.boutKeys)];
  if (uniqMatch.length !== 1 || uniqBout.length < 1) {
    skipped++;
    continue;
  }
  const mk = uniqMatch[0];
  for (const bk of uniqBout) {
    map[bk] = mk;
    kept++;
  }
}

fs.writeFileSync("public/boutKeyToMatchKey.json", JSON.stringify(map, null, 2));
console.log("Wrote public/boutKeyToMatchKey.json");
console.log("Mapped entries:", Object.keys(map).length, "kept:", kept, "skipped tx:", skipped);