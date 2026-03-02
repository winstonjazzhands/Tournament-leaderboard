// scripts/build-rivalries.js
// ESM (works with "type": "module")

import fs from "fs/promises";
import path from "path";

function nowIso() {
  return new Date().toISOString();
}

function normAddr(a) {
  return (a || "").toLowerCase();
}

function toTopList(map, mode /* "w" | "l" */, limit = 3) {
  // map: opp -> { w, l }
  const arr = [];
  for (const [opp, rec] of map.entries()) {
    arr.push({ opp, w: rec.w || 0, l: rec.l || 0 });
  }
  arr.sort((a, b) => {
    if (mode === "w") return (b.w - a.w) || (a.opp.localeCompare(b.opp));
    return (b.l - a.l) || (a.opp.localeCompare(b.opp));
  });
  return arr.slice(0, limit);
}

function ensureOpp(map, opp) {
  let rec = map.get(opp);
  if (!rec) {
    rec = { w: 0, l: 0 };
    map.set(opp, rec);
  }
  return rec;
}

function classifyWallet(p, cfg) {
  // "competitive" wallets: have both wins & losses, enough matches, and winrate not extreme
  const total = p.wins + p.losses;
  const wr = total > 0 ? p.wins / total : 0;

  const isCompetitive =
    p.wins > 0 &&
    p.losses > 0 &&
    total >= cfg.MIN_MATCHES &&
    wr >= cfg.MIN_WINRATE &&
    wr <= cfg.MAX_WINRATE;

  // "system-ish" wallets: extreme winrate OR only wins/losses OR too few matches
  const isSystemish =
    total >= cfg.MIN_MATCHES_SYSTEMISH &&
    (wr >= cfg.SYSTEMISH_WINRATE_HIGH ||
      wr <= cfg.SYSTEMISH_WINRATE_LOW ||
      p.wins === 0 ||
      p.losses === 0);

  return { isCompetitive, isSystemish, winRate: wr, total };
}

async function main() {
  const ROOT = process.cwd();
  const matchesPath = path.join(ROOT, "public", "matches.json");

  // Tunables (env override)
  const cfg = {
    TOP_N: Number(process.env.TOP_N || 3),

    // Competitive filter
    MIN_MATCHES: Number(process.env.MIN_MATCHES || 20),
    MIN_WINRATE: Number(process.env.MIN_WINRATE || 0.05),
    MAX_WINRATE: Number(process.env.MAX_WINRATE || 0.95),

    // System-ish classifier (separate file)
    MIN_MATCHES_SYSTEMISH: Number(process.env.MIN_MATCHES_SYSTEMISH || 50),
    SYSTEMISH_WINRATE_HIGH: Number(process.env.SYSTEMISH_WINRATE_HIGH || 0.98),
    SYSTEMISH_WINRATE_LOW: Number(process.env.SYSTEMISH_WINRATE_LOW || 0.02),
  };

  const raw = JSON.parse(await fs.readFile(matchesPath, "utf8"));
  const matches = raw.matches || [];
  if (!Array.isArray(matches)) {
    throw new Error(`matches.json missing "matches" array: ${matchesPath}`);
  }

  // wallet -> { wins, losses, oppMap(Map<opp,{w,l}>) }
  const stats = new Map();

  let used = 0;
  let skipped = 0;

  for (const m of matches) {
    const a = normAddr(m.playerA);
    const b = normAddr(m.playerB);
    const w = normAddr(m.winner);

    if (!a || !b) {
      skipped++;
      continue;
    }

    // Only count matches where winner is one of the players
    if (w !== a && w !== b) {
      skipped++;
      continue;
    }

    used++;

    const loser = w === a ? b : a;

    // Winner record
    if (!stats.has(w)) stats.set(w, { wallet: w, wins: 0, losses: 0, opp: new Map() });
    const sw = stats.get(w);
    sw.wins++;
    ensureOpp(sw.opp, loser).w++;

    // Loser record
    if (!stats.has(loser)) stats.set(loser, { wallet: loser, wins: 0, losses: 0, opp: new Map() });
    const sl = stats.get(loser);
    sl.losses++;
    ensureOpp(sl.opp, w).l++;
  }

  const allPlayers = [];
  for (const s of stats.values()) {
    const total = s.wins + s.losses;
    const winRate = total ? s.wins / total : 0;

    allPlayers.push({
      wallet: s.wallet,
      wins: s.wins,
      losses: s.losses,
      winRate,
      beatenMost: toTopList(s.opp, "w", cfg.TOP_N),
      lostToMost: toTopList(s.opp, "l", cfg.TOP_N),
      totalMatches: total,
    });
  }

  // Sort: most matches desc, then winrate desc
  allPlayers.sort((x, y) => (y.totalMatches - x.totalMatches) || (y.winRate - x.winRate));

  // Split into competitive vs system-ish vs other
  const competitive = [];
  const systemish = [];
  const other = [];

  for (const p of allPlayers) {
    const { isCompetitive, isSystemish } = classifyWallet(p, cfg);
    if (isCompetitive) competitive.push(p);
    else if (isSystemish) systemish.push(p);
    else other.push(p);
  }

  // Helper to strip internal field if you don't want it in UI
  const strip = (p) => {
    // Keep totalMatches since it's useful debugging; delete it if you want
    return p;
  };

  const outCompetitive = {
    generatedAtUtc: nowIso(),
    source: "public/matches.json",
    thresholds: cfg,
    usedMatches: used,
    skippedMatches: skipped,
    players: competitive.map(strip),
    // helpful debug counts
    counts: {
      allPlayers: allPlayers.length,
      competitive: competitive.length,
      systemish: systemish.length,
      other: other.length,
    },
  };

  const outAll = {
    generatedAtUtc: nowIso(),
    source: "public/matches.json",
    thresholds: cfg,
    usedMatches: used,
    skippedMatches: skipped,
    players: allPlayers.map(strip),
    counts: {
      allPlayers: allPlayers.length,
      competitive: competitive.length,
      systemish: systemish.length,
      other: other.length,
    },
  };

  const outSystem = {
    generatedAtUtc: nowIso(),
    source: "public/matches.json",
    thresholds: cfg,
    usedMatches: used,
    skippedMatches: skipped,
    players: systemish.map(strip),
    counts: {
      allPlayers: allPlayers.length,
      competitive: competitive.length,
      systemish: systemish.length,
      other: other.length,
    },
  };

  const outOther = {
    generatedAtUtc: nowIso(),
    source: "public/matches.json",
    thresholds: cfg,
    usedMatches: used,
    skippedMatches: skipped,
    players: other.map(strip),
    counts: {
      allPlayers: allPlayers.length,
      competitive: competitive.length,
      systemish: systemish.length,
      other: other.length,
    },
  };

  await fs.writeFile(path.join(ROOT, "public", "rivalries.json"), JSON.stringify(outCompetitive, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(ROOT, "public", "rivalries.all.json"), JSON.stringify(outAll, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(ROOT, "public", "rivalries.system.json"), JSON.stringify(outSystem, null, 2) + "\n", "utf8");
  await fs.writeFile(path.join(ROOT, "public", "rivalries.other.json"), JSON.stringify(outOther, null, 2) + "\n", "utf8");

  console.log(
    `wrote public/rivalries.json (competitive): players=${competitive.length} used=${used} skipped=${skipped}`
  );
  console.log(
    `also wrote rivalries.all.json (${allPlayers.length}), rivalries.system.json (${systemish.length}), rivalries.other.json (${other.length})`
  );
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});