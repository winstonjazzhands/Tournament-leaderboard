// scripts/build-votes-json-from-map.js
//
// Builds public/votes.json by joining vote-ledger -> matchToTournament map.
// IMPORTANT: vote-ledger does NOT contain tournamentId directly; we join via boutKey.
//
// This script AUTO-DETECTS which vote word (w0..w4) matches matchToTournament keys,
// and refuses constant-ish candidates (like w4=1).
//
// Usage:
//   node scripts/build-votes-json-from-map.js
//
// Requires:
//   public/votes-ledger.json
//   public/matchToTournament.json
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

function uniqCount(arr) {
  return new Set(arr).size;
}

function pickBestJoinWord(ledger, mapKeys) {
  const candidates = ["w0", "w1", "w2", "w3", "w4"];

  const stats = candidates.map((w) => {
    const vals = ledger.map((r) => asStr(r[w])).filter((v) => v != null);

    const uniques = uniqCount(vals);

    const nonZeroVals = vals.filter((v) => v !== "0");
    const nonZeroUniques = uniqCount(nonZeroVals);

    // Overlap measured on UNIQUE values (not occurrences), to avoid “fake overlaps”
    // from constant flags/enums like w4=1 or w3 in 0..4.
    const uniqSet = new Set(nonZeroVals);
    let overlapUnique = 0;
    for (const v of uniqSet) if (mapKeys.has(v)) overlapUnique++;

    // Small-unique fields are almost always enums/flags; treat them as not joinable.
    const enumLike = nonZeroUniques <= 10;

    // Scoring: prefer real identifiers (lots of uniques) and some unique overlap
    let score = 0;
    score += overlapUnique * 100;                  // overlap matters most
    score += Math.min(2000, nonZeroUniques * 1);   // uniqueness next

    if (enumLike) score -= 100000;                 // nuke enums/flags

    return { w, overlapUnique, uniques, nonZeroUniques, enumLike, score };
  });

  stats.sort((a, b) => b.score - a.score);

  console.log("Join-key candidates (best first):");
  for (const s of stats) {
    console.log(
      `${s.w}: overlapUnique=${s.overlapUnique} uniques=${s.uniques} nonZeroUniques=${s.nonZeroUniques} enumLike=${s.enumLike} score=${s.score}`
    );
  }

  // Choose: must overlap on unique values AND look like a real key (not enumLike).
  const chosen = stats.find((s) => s.overlapUnique > 0 && !s.enumLike);

  if (!chosen) {
    throw new Error(
      "Could not find a reliable join word. (Only enum/flag-like fields overlapped with match keys.)"
    );
  }

  return chosen.w;
}

const ledger = readJson("public/votes-ledger.json");
const map = readJson("public/matchToTournament.json");
const mapKeys = new Set(Object.keys(map));

// Auto-detect vote join word against map keys
const JOIN_WORD = pickBestJoinWord(ledger, mapKeys);
console.log("Using vote join word:", JOIN_WORD);

let kept = 0;
let droppedNoTournament = 0;
let droppedZeroVotes = 0;

const votes = [];

for (const r of ledger) {
  const boutKey = asStr(r[JOIN_WORD]);
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
    voter: r.voter,
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

console.log("Wrote public/votes.json");
console.log("Wrote public/voteTotals.json");
console.log("Wrote public/votesByWallet.json");
console.log("Kept:", kept);
console.log("Dropped (no tournamentId):", droppedNoTournament);
console.log("Dropped (zero votes):", droppedZeroVotes);
console.log("Unique tournaments:", new Set(votes.map(v => v.tournamentId)).size);
console.log("Unique bouts:", new Set(votes.map(v => v.boutKey)).size);