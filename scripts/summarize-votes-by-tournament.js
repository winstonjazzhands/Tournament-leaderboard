// scripts/summarize-votes-by-tournament.js
//
// Reads public/votes.json and prints a compact summary per raw tournamentId:
// - unique fights (fightIndex)
// - unique boutKeys
// - unique voters
// - total votes (raw and scaled /100)
// - first/last vote timestamps (UTC)
//
// Usage:
//   node scripts/summarize-votes-by-tournament.js
//   node scripts/summarize-votes-by-tournament.js 20   (top N by total votes)

import fs from "fs";

const VOTE_SCALE = 100n;

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function toUTC(sec) {
  try {
    const d = new Date(Number(sec) * 1000);
    return d.toISOString().replace(".000Z", "Z");
  } catch {
    return "";
  }
}
function fmtInt(x) {
  try { return Number(x).toLocaleString(); } catch { return String(x); }
}
function fmtVotes(rawStr) {
  let x = 0n;
  try { x = BigInt(String(rawStr)); } catch {}
  const whole = x / VOTE_SCALE;
  const frac = x % VOTE_SCALE;
  if (frac === 0n) return fmtInt(whole.toString());
  const fracStr = frac.toString().padStart(2,"0").replace(/0+$/,"");
  return fmtInt(whole.toString()) + "." + fracStr;
}

const topN = process.argv[2] ? Number(process.argv[2]) : 0;

const votes = readJson("public/votes.json");

const byT = new Map();
for (const v of votes) {
  const tid = String(v.tournamentId ?? "");
  if (!tid) continue;

  const fight = v.fightIndex == null ? "unknown" : String(v.fightIndex);
  const boutKey = String(v.boutKey ?? "");
  const voter = (v.voter || "").toLowerCase();
  const ts = Number(v.timestamp || 0);

  let amt = 0n;
  try { amt = BigInt(String(v.votes || "0")); } catch {}

  if (!byT.has(tid)) {
    byT.set(tid, {
      tid,
      fights: new Set(),
      bouts: new Set(),
      voters: new Set(),
      total: 0n,
      firstTs: ts || null,
      lastTs: ts || null,
    });
  }
  const t = byT.get(tid);
  t.fights.add(fight);
  if (boutKey) t.bouts.add(boutKey);
  if (voter) t.voters.add(voter);
  t.total += amt;

  if (ts) {
    if (t.firstTs == null || ts < t.firstTs) t.firstTs = ts;
    if (t.lastTs == null || ts > t.lastTs) t.lastTs = ts;
  }
}

let rows = [...byT.values()].map(t => ({
  tid: t.tid,
  fights: t.fights.size,
  bouts: t.bouts.size,
  voters: t.voters.size,
  totalRaw: t.total.toString(),
  totalScaled: fmtVotes(t.total.toString()),
  first: t.firstTs ? toUTC(t.firstTs) : "",
  last: t.lastTs ? toUTC(t.lastTs) : "",
}));

rows.sort((a,b) => BigInt(b.totalRaw) > BigInt(a.totalRaw) ? 1 : -1);

if (topN > 0) rows = rows.slice(0, topN);

console.log("rawTid  fights  bouts  voters  totalVotes  firstUTC                lastUTC");
for (const r of rows) {
  console.log(
    r.tid.padEnd(6),
    String(r.fights).padEnd(6),
    String(r.bouts).padEnd(5),
    String(r.voters).padEnd(6),
    String(r.totalScaled).padEnd(10),
    (r.first || "").padEnd(22),
    r.last || ""
  );
}
