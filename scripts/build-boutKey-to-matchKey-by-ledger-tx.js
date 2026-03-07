// scripts/build-boutKey-to-matchKey-by-ledger-tx.js
//
// Builds boutKey -> matchKey by joining your votes ledger to match logs via txHash.
//
// Ledger fields (per your sample):
//   txHash, w1 (boutKey), amount, w3(side), etc.
//
// Usage:
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/build-boutKey-to-matchKey-by-ledger-tx.js 22000000 22320000
//
// Output:
//   public/boutKeyToMatchKey.json

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// Default (from your earlier logs): match topic0
// Override by setting MATCH_TOPIC0 env var if needed.
const DEFAULT_MATCH_TOPIC0 =
  "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

const MATCH_TOPIC0 = (process.env.MATCH_TOPIC0 || DEFAULT_MATCH_TOPIC0).toLowerCase();

// Your latest inference: matchKey word index in match log data = 3
const MATCHKEY_WORD_INDEX = 3;

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  console.error("Set RPC_URL first.");
  process.exit(1);
}

const fromBlock = Number(process.argv[2] || 22000000);
const toBlock = Number(process.argv[3] || 22320000);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function splitWords(hex) {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) out.push("0x" + chunk);
  }
  return out;
}

const u32 = (hexWord) => BigInt(hexWord).toString();

const provider = new ethers.JsonRpcProvider(rpcUrl);

console.log("Reading votes ledger...");
const ledger = readJson("public/votes-ledger.json");
console.log("Ledger rows:", ledger.length);

// txHash -> Set(boutKey)
const ledgerByTx = new Map();
for (const r of ledger) {
  const tx = (r.txHash || r.transactionHash || "").toLowerCase();
  // IMPORTANT: your boutKey lives in w1
  const bk = r.w1 != null ? String(r.w1) : "";
  if (!tx || !bk) continue;
  if (!ledgerByTx.has(tx)) ledgerByTx.set(tx, new Set());
  ledgerByTx.get(tx).add(bk);
}
console.log("Ledger unique tx:", ledgerByTx.size);

// Scan match logs
console.log("Scanning match logs:", fromBlock, "->", toBlock);
console.log("Using MATCH_TOPIC0:", MATCH_TOPIC0);

const matchLogs = await provider.getLogs({
  address: DIAMOND,
  fromBlock,
  toBlock,
  topics: [MATCH_TOPIC0],
});
console.log("Match logs:", matchLogs.length);

// txHash -> Set(matchKey)
const matchByTx = new Map();
for (const l of matchLogs) {
  const tx = (l.transactionHash || "").toLowerCase();
  if (!tx) continue;
  const words = splitWords(l.data);
  const mk = words[MATCHKEY_WORD_INDEX] ? u32(words[MATCHKEY_WORD_INDEX]) : null;
  if (!mk) continue;
  if (!matchByTx.has(tx)) matchByTx.set(tx, new Set());
  matchByTx.get(tx).add(mk);
}

// Join (unambiguous only)
const map = {};
let mapped = 0;
let skippedNoMatch = 0;
let skippedAmbiguous = 0;

for (const [tx, boutSet] of ledgerByTx.entries()) {
  const mset = matchByTx.get(tx);
  if (!mset) {
    skippedNoMatch++;
    continue;
  }
  const matchKeys = [...mset];
  if (matchKeys.length !== 1) {
    skippedAmbiguous++;
    continue;
  }
  const mk = matchKeys[0];
  for (const bk of boutSet) {
    map[bk] = mk;
    mapped++;
  }
}

fs.writeFileSync("public/boutKeyToMatchKey.json", JSON.stringify(map, null, 2));
console.log("Wrote public/boutKeyToMatchKey.json");
console.log("Mapped unique boutKeys:", Object.keys(map).length, "mapped entries:", mapped);
console.log("Skipped tx (no match log):", skippedNoMatch);
console.log("Skipped tx (ambiguous match keys):", skippedAmbiguous);