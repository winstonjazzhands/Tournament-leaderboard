// scripts/profile-vote-ledger.js
// Usage: node scripts/profile-vote-ledger.js

import fs from "fs";

const rows = JSON.parse(fs.readFileSync("public/votes-ledger.json", "utf8"));

const keys = ["w0","w1","w2","w3","w4"]; // w5 is amount
function uniq(arr){ return new Set(arr).size; }

function topCounts(values, n=12){
  const m = new Map();
  for (const v of values) m.set(v, (m.get(v)||0)+1);
  return [...m.entries()].sort((a,b)=>b[1]-a[1]).slice(0,n);
}

for (const k of keys){
  const vals = rows.map(r => r[k]).filter(v => v != null);
  const u = uniq(vals);
  const nums = vals.map(v => Number(v)).filter(n => Number.isFinite(n));
  const max = nums.length ? Math.max(...nums) : null;
  const min = nums.length ? Math.min(...nums) : null;

  console.log(`\n== ${k} ==`);
  console.log(`unique: ${u}`);
  console.log(`min/max: ${min} / ${max}`);
  console.log("top values:", topCounts(vals).map(([v,c]) => `${v}:${c}`).join(", "));
}