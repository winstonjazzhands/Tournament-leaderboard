// scripts/build-votes-json-joined.js
// Builds public/votes.json with REAL 4-digit tournamentId by joining votes-ledger -> matches.
//
// Usage:
//   node scripts/build-votes-json-joined.js
//
// Requires:
//   public/votes-ledger.json
//   public/matches.json  (array OR wrapper object containing an array)

import fs from "fs";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function asStr(x) {
  if (x == null) return null;
  return String(x);
}

// Try hard to find an array inside common wrapper shapes
function unwrapArray(x) {
  if (Array.isArray(x)) return x;

  // common wrapper keys
  const candidates = [
    x?.matches,
    x?.match,
    x?.rows,
    x?.items,
    x?.data?.matches,
    x?.data?.rows,
    x?.result?.matches,
    x?.result?.rows,
    x?.payload?.matches,
    x?.payload?.rows,
  ];

  for (const c of candidates) {
    if (Array.isArray(c)) return c;
  }

  // last-resort: if it’s an object of objects, maybe values are the rows
  if (x && typeof x === "object") {
    const vals = Object.values(x);
    if (vals.length && vals.every(v => v && typeof v === "object")) return vals;
  }

  return null;
}

function main() {
  const ledgerRaw = readJson("public/votes-ledger.json");
  const matchesRaw = readJson("public/matches.json");

  const ledger = unwrapArray(ledgerRaw) || [];
  const matches = unwrapArray(matchesRaw);

  if (!matches) {
    console.error("ERROR: public/matches.json is not an array and no wrapper key matched.");
    console.error("Tip: run `node -e \"console.log(Object.keys(require('./public/matches.json')) )\"` (CommonJS) won’t work in ESM.");
    console.error("Instead run: node -e \"import('./public/matches.json',{assert:{type:'json'}}).then(m=>console.log(Object.keys(m.default)))\" ");
    process.exit(1);
  }

  // Build lookup: matchKey(string) -> tournamentId(string <= 9999)
  const matchToTournament = new Map();

  for (const m of matches) {
    if (!m || typeof m !== "object") continue;

    const tournamentId =
      m.tournamentId ?? m.tournament_id ?? m.tournament ?? m.tid ?? m.tournamentID ?? null;

    const matchKey =
      m.matchKey ?? m.match_key ?? m.matchId ?? m.match_id ?? m.match ?? m.id ?? null;

    if (tournamentId == null || matchKey == null) continue;

    const tStr = asStr(tournamentId);
    const mkStr = asStr(matchKey);

    const tNum = Number(tStr);
    if (!Number.isFinite(tNum) || tNum < 0 || tNum > 9999) continue;

    matchToTournament.set(mkStr, tStr);
  }

  let kept = 0, dropped = 0;

  const out = [];
  for (const r of ledger) {
    const voter = r.voter || r.wallet || r.from || r.address || null;
    const votes = asStr(r.amount ?? r.votes ?? "0");

    // vote event match key (from your profiling: w1 varies most)
    const matchKey = asStr(r.w1);
    const tournamentId = matchToTournament.get(matchKey);

    // your rule: exclude anything without tournamentId
    if (!tournamentId) { dropped++; continue; }

    // side stays raw (your data shows 0..4); we’ll keep it as-is
    const side = asStr(r.w3);

    out.push({
      tournamentId,
      matchKey,
      side,
      votes,
      voter,
      timestamp: r.timestamp ?? null,
      txHash: r.txHash ?? r.transactionHash ?? null,
      blockNumber: r.blockNumber ?? null,
    });
    kept++;
  }

  // newest first
  out.sort((a, b) => (Number(b.timestamp || 0) - Number(a.timestamp || 0)));

  fs.writeFileSync("public/votes.json", JSON.stringify(out, null, 2));

  console.log("Wrote public/votes.json");
  console.log("Lookup entries:", matchToTournament.size);
  console.log("Kept:", kept, "Dropped(no tournamentId):", dropped);
}

main();