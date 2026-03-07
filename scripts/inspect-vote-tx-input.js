// scripts/inspect-vote-tx-input.js
//
// Fetches a transaction and prints 32-byte words from input data
// with any small ints that look like IDs (<= 10000), so we can
// spot a UI-facing tournament ID like ~1982.
//
// Usage:
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/inspect-vote-tx-input.js <txHash>
//
// Tip: pick a txHash from public/votes.json that you believe belongs
// to Tournament #1982 by date, then run this. If you see 1982 show up,
// we can lock the correct word index.

import { ethers } from "ethers";

const txHash = process.argv[2];
if (!txHash) {
  console.error("Usage: node scripts/inspect-vote-tx-input.js <txHash>");
  process.exit(1);
}

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  console.error("Set RPC_URL first.");
  process.exit(1);
}

function splitWords(hex) {
  const data = hex.startsWith("0x") ? hex.slice(2) : hex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) words.push("0x" + chunk);
  }
  return words;
}

function u(hex){ return BigInt(hex); }
function numSafe(hex){
  try { return Number(u(hex)); } catch { return null; }
}

const provider = new ethers.JsonRpcProvider(rpcUrl);

const tx = await provider.getTransaction(txHash);
if (!tx) {
  console.error("Transaction not found:", txHash);
  process.exit(1);
}

console.log("TX:", txHash);
console.log("from:", tx.from);
console.log("to  :", tx.to);
console.log("data bytes:", (tx.data.length - 2) / 2);

const words = splitWords(tx.data);
console.log("word count:", words.length);
console.log("method selector:", tx.data.slice(0, 10));

const hits = [];
for (let i = 0; i < Math.min(words.length, 40); i++){
  const v = numSafe(words[i]);
  if (v == null) continue;
  if (v >= 0 && v <= 10000) hits.push({ idx: i, val: v });
}

console.log("Small-int candidates (<=10000):");
for (const h of hits) {
  console.log("  w" + h.idx + " =", h.val);
}
