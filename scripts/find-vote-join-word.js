// scripts/find-vote-join-word.js
// Finds which vote-ledger word (w0..w4) best matches matchToTournament keys.
//
// Usage:
//   node scripts/find-vote-join-word.js

import fs from "fs";

const ledger = JSON.parse(fs.readFileSync("public/votes-ledger.json", "utf8"));
const map = JSON.parse(fs.readFileSync("public/matchToTournament.json", "utf8"));
const mapKeys = new Set(Object.keys(map));

const words = ["w0","w1","w2","w3","w4"];

function countOverlap(word){
  let overlap = 0;
  let nonZero = 0;
  let zeros = 0;
  for (const r of ledger){
    const v = r[word] != null ? String(r[word]) : null;
    if (!v) continue;
    if (v === "0") zeros++;
    else nonZero++;
    if (mapKeys.has(v)) overlap++;
  }
  return { word, overlap, nonZero, zeros };
}

const results = words.map(countOverlap).sort((a,b)=> b.overlap - a.overlap);
console.log("Join-word overlap vs matchToTournament keys:");
for (const r of results){
  console.log(`${r.word}: overlap=${r.overlap} (nonZero=${r.nonZero}, zeros=${r.zeros})`);
}