// scripts/scan-boutmap-fields-for-ui-tournamentid.js
//
// Scans the bout mapping event logs and reports, per data word index,
// how many values look like UI tournament IDs (e.g., 1500..2500) and
// shows the most common values.
//
// Usage:
//   set RPC_URL=...
//   node scripts/scan-boutmap-fields-for-ui-tournamentid.js
//   node scripts/scan-boutmap-fields-for-ui-tournamentid.js 22000000 22320000
//
// If we see something like word wX having lots of values around 1900..2200,
// that's our actual UI tournamentId field.

import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";
const TOPIC0 =
  "0x212d381b01f1e26324135ac9efbe6e1506536df18f511a42fba4c58f7d7af280";

const DEFAULT_FROM = 22000000;
const DEFAULT_TO = 22320000;

const rpcUrl = process.env.RPC_URL;
if (!rpcUrl) {
  console.error("Set RPC_URL first.");
  process.exit(1);
}

const fromBlock = process.argv[2] ? Number(process.argv[2]) : DEFAULT_FROM;
const toBlock = process.argv[3] ? Number(process.argv[3]) : DEFAULT_TO;

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) words.push("0x" + chunk);
  }
  return words;
}
const u = (hex) => BigInt(hex);
const num = (hex) => {
  try { return Number(u(hex)); } catch { return null; }
};

const provider = new ethers.JsonRpcProvider(rpcUrl);

console.log("Scanning mapping logs:", fromBlock, "->", toBlock);

const logs = await provider.getLogs({
  address: DIAMOND,
  fromBlock,
  toBlock,
  topics: [TOPIC0],
});

console.log("Found logs:", logs.length);
if (!logs.length) process.exit(0);

const MIN = 1500;
const MAX = 2500;

const perWord = new Map(); // idx -> { hits, unique:Set, top:Map }
for (const l of logs) {
  const words = splitWords(l.data);
  for (let i = 0; i < Math.min(words.length, 12); i++) {
    const v = num(words[i]);
    if (v == null) continue;
    if (v < MIN || v > MAX) continue;

    if (!perWord.has(i)) perWord.set(i, { hits: 0, unique: new Set(), top: new Map() });
    const p = perWord.get(i);
    p.hits++;
    p.unique.add(v);
    p.top.set(v, (p.top.get(v) || 0) + 1);
  }
}

const rows = [...perWord.entries()].map(([idx, p]) => {
  const top = [...p.top.entries()].sort((a,b)=>b[1]-a[1]).slice(0, 10);
  return { idx, hits: p.hits, uniq: p.unique.size, top };
}).sort((a,b)=>b.hits-a.hits);

for (const r of rows) {
  console.log(`\n== data word w${r.idx} == hits=${r.hits} unique=${r.uniq}`);
  for (const [val, cnt] of r.top) console.log(`  ${val} -> ${cnt}`);
}

console.log("\nDone. If no words show many hits in 1500..2500, the UI tournamentId is not in this event's data.");
