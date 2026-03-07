// scripts/find-matchkey-field-in-matchlogs.js
//
// Tries to find which match-log word equals a vote boutKey sample (w1 values).
// Usage:
//   node scripts/find-matchkey-field-in-matchlogs.js

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";
const MATCH_TOPIC0 = "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push("0x" + data.slice(i, i + 64));
  return words;
}
const u = (hex) => BigInt(hex).toString();

async function main(){
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL first.");

  const ledger = JSON.parse(fs.readFileSync("public/votes-ledger.json","utf8"));
  // Grab up to 50 unique nonzero vote bout keys (w1)
  const boutKeys = [];
  const seen = new Set();
  for (const r of ledger){
    const k = r.w1 != null ? String(r.w1) : null;
    const amt = BigInt(String(r.amount ?? "0"));
    if (!k || amt <= 0n) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    boutKeys.push(k);
    if (boutKeys.length >= 50) break;
  }

  console.log("Sample vote boutKeys (w1):", boutKeys.length);

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const logs = await provider.getLogs({ address: DIAMOND, fromBlock: 22000000, toBlock: 22320000, topics: [MATCH_TOPIC0] });
  console.log("Match logs:", logs.length);

  const hits = new Map(); // wordIndex -> count
  for (const l of logs){
    const words = splitWords(l.data).map(u);
    for (let i=0;i<words.length;i++){
      if (!hits.has(i)) hits.set(i, 0);
    }
    for (let i=0;i<words.length;i++){
      if (seen.has(words[i])) hits.set(i, hits.get(i)+1);
    }
  }

  const sorted = [...hits.entries()].sort((a,b)=>b[1]-a[1]).slice(0,10);
  console.log("Top matching match-log word indexes (count of matches vs sample keys):");
  for (const [i,c] of sorted) console.log(`w${i}: ${c}`);
}

main().catch(e=>{ console.error(e); process.exit(1); });