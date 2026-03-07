// scripts/build-votes-json-from-txjoin.js
//
// Rebuild votes.json using txHash-based join:
//
// votes-ledger.json rows include boutKey and vote amount (field name varies).
// boutKeyToMatchKey.json maps boutKey -> matchKey (built from tx joins).
// matchToTournament.json maps matchKey -> tournamentId (built from match logs).
//
// Output:
//   public/votes.json
//   public/voteTotalsByFight.json
//   public/votesByWallet.json
//
// Usage:
//   node scripts/build-votes-json-from-txjoin.js
//
// Notes:
// - Drops rows with no join to matchKey/tournamentId
// - Drops zero-vote rows
// - Leaves fightIndex null for now (we can derive later)

import fs from "fs";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function toStr(x) {
  return x == null ? "" : String(x);
}
function safeInt(x, fallback = 0) {
  const n = Number(x);
  return Number.isFinite(n) ? n : fallback;
}

function pickFirstKey(obj, keys) {
  for (const k of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, k) && obj[k] != null) return k;
  }
  return null;
}

function toBigIntMaybe(x) {
  try {
    // handle numbers, numeric strings
    if (typeof x === "number") return BigInt(Math.trunc(x));
    const s = String(x).trim();
    if (!s) return null;
    // reject non-integer strings
    if (!/^-?\d+$/.test(s)) return null;
    return BigInt(s);
  } catch {
    return null;
  }
}

function main() {
  const ledger = readJson("public/votes-ledger.json");
  const boutKeyToMatchKey = readJson("public/boutKeyToMatchKey.json");
  const matchToTournament = readJson("public/matchToTournament.json");

  if (!Array.isArray(ledger) || ledger.length === 0) {
    console.error("votes-ledger.json is empty or not an array.");
    process.exit(1);
  }

  // Detect field names from the first row
  const sample = ledger[0];
  const boutKeyField =
    pickFirstKey(sample, ["boutKey", "boutkey", "bout", "bout_key", "matchKey", "matchId"]) ||
    "boutKey";

  const votesField =
    pickFirstKey(sample, ["votes", "amount", "voteAmount", "value", "w5", "rawVotes"]) ||
    "votes";

  const fightIndexField =
    pickFirstKey(sample, ["fightIndex", "fight", "round", "w3"]) ||
    "fightIndex";

  const sideField = pickFirstKey(sample, ["side", "fighterId", "team", "selection", "w4", "w3"]) || "side";
  const voterField = pickFirstKey(sample, ["voter", "wallet", "from"]) || "voter";

  console.log("Detected fields:");
  console.log("  boutKeyField:", boutKeyField);
  console.log("  votesField  :", votesField);
  console.log("  sideField   :", sideField);
  console.log("  voterField  :", voterField);
  console.log("  fightIndexField:", fightIndexField);

  let kept = 0;
  let droppedNoJoin = 0;
  let droppedZero = 0;
  let droppedBadAmount = 0;

  const out = [];

  for (const row of ledger) {
    const boutKey = toStr(row[boutKeyField] ?? row.w1 ?? "");
    if (!boutKey) {
      droppedNoJoin++;
      continue;
    }

    const amtBI = toBigIntMaybe(row[votesField]);
    if (amtBI == null) {
      droppedBadAmount++;
      continue;
    }
    if (amtBI === 0n) {
      droppedZero++;
      continue;
    }

    const matchKey = boutKeyToMatchKey[boutKey];
    if (!matchKey) {
      droppedNoJoin++;
      continue;
    }

    const tournamentIdRaw = matchToTournament[toStr(matchKey)];
    const uiTournamentId = (boutMeta[boutKey]?.uiTournamentId || boutToUiTournament[boutKey] || null);
    const tournamentId = uiTournamentId ? String(uiTournamentId) : String(tournamentIdRaw);
    if (!tournamentId) {
      droppedNoJoin++;
      continue;
    }

    out.push({
      tournamentId: toStr(tournamentId),
      matchKey: toStr(matchKey),
      fightIndex: (() => {
        const fi = Number(row[fightIndexField]);
        return Number.isFinite(fi) && fi >= 0 && fi <= 6 ? fi : null;
      })(),
      fightIndex: (() => {
        const fi = Number(row[fightIndexField]);
        return Number.isFinite(fi) && fi >= 0 && fi <= 6 ? fi : null;
      })(),
      boutKey: boutKey,
      side: toStr(row[sideField]),
      votes: amtBI.toString(),
      voter: toStr(row[voterField]).toLowerCase(),
      timestamp: safeInt(row.timestamp, 0),
      txHash: toStr(row.txHash || row.transactionHash || ""),
      blockNumber: safeInt(row.blockNumber, 0),
    });

    kept++;
  }

  // Totals by (tournamentId + matchKey)
  const totalsByFight = {}; // `${tid}:${matchKey}` -> { tournamentId, matchKey, totalVotes, uniqueVoters, sideTotals }
  const votersByFight = {}; // key -> Set
  const byWallet = {};      // wallet -> { wallet, totalVotes, tournaments: {tid: votes} }

  for (const v of out) {
    const tid = v.tournamentId;
    const mk = v.matchKey;
    const fightKey = (v.fightIndex != null) ? String(v.fightIndex) : mk;
    const key = `${tid}:${fightKey}`;
    const voter = v.voter;
    const side = v.side;
    const amt = BigInt(v.votes);

    if (!totalsByFight[key]) {
      totalsByFight[key] = {
        tournamentId: tid,
        fightIndex: v.fightIndex,
        matchKey: mk,
        matchKeys: [mk],
        totalVotes: "0",
        uniqueVoters: 0,
        sideTotals: {},
      };
      votersByFight[key] = new Set();
    }

    // track contributing matchKeys
    if (totalsByFight[key].matchKeys && mk && !totalsByFight[key].matchKeys.includes(mk)) {
      totalsByFight[key].matchKeys.push(mk);
    }

    // track contributing matchKeys
    if (totalsByFight[key].matchKeys && mk && !totalsByFight[key].matchKeys.includes(mk)) {
      totalsByFight[key].matchKeys.push(mk);
    }

    totalsByFight[key].totalVotes = (BigInt(totalsByFight[key].totalVotes) + amt).toString();
    if (voter) votersByFight[key].add(voter);
    totalsByFight[key].sideTotals[side] =
      (BigInt(totalsByFight[key].sideTotals[side] || "0") + amt).toString();

    if (voter) {
      if (!byWallet[voter]) byWallet[voter] = { wallet: voter, totalVotes: "0", tournaments: {} };
      byWallet[voter].totalVotes = (BigInt(byWallet[voter].totalVotes) + amt).toString();
      byWallet[voter].tournaments[tid] =
        (BigInt(byWallet[voter].tournaments[tid] || "0") + amt).toString();
    }
  }

  for (const k of Object.keys(totalsByFight)) {
    totalsByFight[k].uniqueVoters = votersByFight[k].size;
  }

  writeJson("public/votes.json", out);
  writeJson("public/voteTotalsByFight.json", Object.values(totalsByFight));
  writeJson("public/votesByWallet.json", Object.values(byWallet));

  const uniqueT = new Set(out.map((x) => x.tournamentId)).size;
  const uniqueF = new Set(out.map((x) => `${x.tournamentId}:${x.fightIndex != null ? x.fightIndex : x.matchKey}`)).size;

  console.log("Wrote public/votes.json");
  console.log("Wrote public/voteTotalsByFight.json");
  console.log("Wrote public/votesByWallet.json");
  console.log("Kept:", kept);
  console.log("Dropped (no join/tournament):", droppedNoJoin);
  console.log("Dropped (zero votes):", droppedZero);
  console.log("Dropped (bad amount):", droppedBadAmount);
  console.log("Unique tournaments:", uniqueT);
  console.log("Unique fights:", uniqueF);
}

main();