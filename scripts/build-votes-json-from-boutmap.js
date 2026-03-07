// scripts/build-votes-json-from-boutmap.js
//
// Builds public/votes.json by joining:
//   public/votes-ledger.json  (vote logs decoded to words)
// with
//   public/boutToTournament.json (boutKey -> tournamentId)
//
// Discovered:
//   vote boutKey lives in vote-ledger w1
//
// Drops rows where votes == 0.
//
// Usage:
//   node scripts/build-votes-json-from-boutmap.js
//
// Requires:
//   public/votes-ledger.json
//   public/boutToTournament.json
//
// Outputs:
//   public/votes.json
//   public/voteTotals.json
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
const map = readJson("public/boutToTournament.json");

let kept = 0;
let droppedNoTournament = 0;
let droppedZeroVotes = 0;

const votes = [];

for (const r of ledger) {
  const boutKey = asStr(r.w1); // ✅ correct vote boutKey
  if (!boutKey) { droppedNoTournament++; continue; }

  const voteAmtStr = asStr(r.amount ?? r.votes ?? "0") ?? "0";
  let voteAmt = 0n;
  try { voteAmt = BigInt(voteAmtStr); } catch { voteAmt = 0n; }

  if (voteAmt <= 0n) {
    droppedZeroVotes++;
    continue;
  }

  const tournamentId = map[boutKey];
  if (!tournamentId) {
    droppedNoTournament++;
    continue;
  }

  votes.push({
    tournamentId: String(tournamentId),
    boutKey,
    side: r.w3 != null ? String(r.w3) : null, // keep raw for now
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

// Totals: tournament -> bout -> side
const voteTotals = {}; // voteTotals[tid][boutKey][side] = sum
for (const v of votes) {
  const t = v.tournamentId;
  const b = v.boutKey ?? "unknown";
  const s = v.side ?? "unknown";

  voteTotals[t] ??= {};
  voteTotals[t][b] ??= {};
  voteTotals[t][b][s] ??= "0";
  voteTotals[t][b][s] = (BigInt(voteTotals[t][b][s]) + BigInt(v.votes)).toString();
}
writeJson("public/voteTotals.json", voteTotals);

// By wallet: wallet -> tournaments -> bouts
const votesByWallet = {}; // wallet -> { totalVotes, tournaments: { tid: { totalVotes, bouts: { boutKey: { totalVotes, bySide } } } } }
for (const v of votes) {
  const w = v.voter;
  const t = v.tournamentId;
  const b = v.boutKey ?? "unknown";
  const s = v.side ?? "unknown";

  votesByWallet[w] ??= { totalVotes: "0", tournaments: {} };
  votesByWallet[w].totalVotes = (BigInt(votesByWallet[w].totalVotes) + BigInt(v.votes)).toString();

  votesByWallet[w].tournaments[t] ??= { totalVotes: "0", bouts: {} };
  votesByWallet[w].tournaments[t].totalVotes =
    (BigInt(votesByWallet[w].tournaments[t].totalVotes) + BigInt(v.votes)).toString();

  votesByWallet[w].tournaments[t].bouts[b] ??= { totalVotes: "0", bySide: {} };
  votesByWallet[w].tournaments[t].bouts[b].totalVotes =
    (BigInt(votesByWallet[w].tournaments[t].bouts[b].totalVotes) + BigInt(v.votes)).toString();

  votesByWallet[w].tournaments[t].bouts[b].bySide[s] ??= "0";
  votesByWallet[w].tournaments[t].bouts[b].bySide[s] =
    (BigInt(votesByWallet[w].tournaments[t].bouts[b].bySide[s]) + BigInt(v.votes)).toString();
}
writeJson("public/votesByWallet.json", votesByWallet);

console.log("Using vote join word: w1 (boutKey)");
console.log("Wrote public/votes.json");
console.log("Wrote public/voteTotals.json");
console.log("Wrote public/votesByWallet.json");
console.log("Kept:", kept);
console.log("Dropped (no tournamentId):", droppedNoTournament);
console.log("Dropped (zero votes):", droppedZeroVotes);
console.log("Unique tournaments:", new Set(votes.map(v => v.tournamentId)).size);
console.log("Unique bouts:", new Set(votes.map(v => v.boutKey)).size);
