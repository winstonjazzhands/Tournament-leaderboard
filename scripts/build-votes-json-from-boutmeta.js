// scripts/build-votes-json-from-boutmeta.js
//
// Builds public/votes.json grouped-friendly by attaching fightIndex.
//
// Joins:
//   public/votes-ledger.json
//   public/boutMeta.json  (boutKey -> { tournamentId, fightIndex })
//
// Vote boutKey is vote-ledger w1.
// Vote side stays as vote-ledger w3 (raw); UI can map top-2 sides to A/B per fight.
//
// Drops rows where votes == 0.
//
// Usage:
//   node scripts/build-votes-json-from-boutmeta.js
//
// Outputs:
//   public/votes.json
//   public/voteTotalsByFight.json
//   public/votesByWallet.json

import fs from "fs";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, x) {
  fs.writeFileSync(p, JSON.stringify(x, null, 2));
}
function asStr(x) {
  return x == null ? null : String(x);
}

const ledger = readJson("public/votes-ledger.json");
const meta = readJson("public/boutMeta.json");

let kept = 0;
let droppedNoMeta = 0;
let droppedZeroVotes = 0;

const votes = [];

for (const r of ledger) {
  const boutKey = asStr(r.w1);
  if (!boutKey) { droppedNoMeta++; continue; }

  const m = meta[boutKey];
  if (!m || !m.tournamentId) { droppedNoMeta++; continue; }

  const voteAmtStr = asStr(r.amount ?? r.votes ?? "0") ?? "0";
  let voteAmt = 0n;
  try { voteAmt = BigInt(voteAmtStr); } catch { voteAmt = 0n; }

  if (voteAmt <= 0n) { droppedZeroVotes++; continue; }

  votes.push({
    tournamentId: String(m.tournamentId),
    fightIndex: m.fightIndex,     // may be null if not inferred; but usually will be 1..7-ish
    boutKey,                      // keep for debugging
    side: r.w3 != null ? String(r.w3) : null,
    votes: voteAmt.toString(),
    voter: (r.voter || "").toLowerCase(),
    timestamp: r.timestamp ?? null,
    txHash: r.txHash ?? r.transactionHash ?? null,
    blockNumber: r.blockNumber ?? null,
  });

  kept++;
}

// newest first
votes.sort((a, b) => (Number(b.timestamp || 0) - Number(a.timestamp || 0)));
writeJson("public/votes.json", votes);

// Totals by fight: tournamentId -> fightIndex -> side -> sum
const totals = {};
for (const v of votes) {
  const t = v.tournamentId;
  const f = (v.fightIndex == null ? "unknown" : String(v.fightIndex));
  const s = v.side ?? "unknown";
  totals[t] ??= {};
  totals[t][f] ??= {};
  totals[t][f][s] ??= "0";
  totals[t][f][s] = (BigInt(totals[t][f][s]) + BigInt(v.votes)).toString();
}
writeJson("public/voteTotalsByFight.json", totals);

// By wallet: wallet -> tournaments -> fights
const byWallet = {};
for (const v of votes) {
  const w = v.voter;
  const t = v.tournamentId;
  const f = (v.fightIndex == null ? "unknown" : String(v.fightIndex));
  const s = v.side ?? "unknown";

  byWallet[w] ??= { totalVotes: "0", tournaments: {} };
  byWallet[w].totalVotes = (BigInt(byWallet[w].totalVotes) + BigInt(v.votes)).toString();

  byWallet[w].tournaments[t] ??= { totalVotes: "0", fights: {} };
  byWallet[w].tournaments[t].totalVotes =
    (BigInt(byWallet[w].tournaments[t].totalVotes) + BigInt(v.votes)).toString();

  byWallet[w].tournaments[t].fights[f] ??= { totalVotes: "0", bySide: {} };
  byWallet[w].tournaments[t].fights[f].totalVotes =
    (BigInt(byWallet[w].tournaments[t].fights[f].totalVotes) + BigInt(v.votes)).toString();

  byWallet[w].tournaments[t].fights[f].bySide[s] ??= "0";
  byWallet[w].tournaments[t].fights[f].bySide[s] =
    (BigInt(byWallet[w].tournaments[t].fights[f].bySide[s]) + BigInt(v.votes)).toString();
}
writeJson("public/votesByWallet.json", byWallet);

console.log("Wrote public/votes.json");
console.log("Wrote public/voteTotalsByFight.json");
console.log("Wrote public/votesByWallet.json");
console.log("Kept:", kept);
console.log("Dropped (no meta/tournamentId):", droppedNoMeta);
console.log("Dropped (zero votes):", droppedZeroVotes);
console.log("Unique tournaments:", new Set(votes.map(v => v.tournamentId)).size);
console.log("Unique fights:", new Set(votes.map(v => (v.fightIndex==null?'unknown':String(v.fightIndex)))).size);
