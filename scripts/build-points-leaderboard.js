// scripts/build-points-leaderboard.js
import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const RESULTS_INPUT = path.join(ROOT, "public", "tournament-results.json");
const MATCHES_INPUT = path.join(ROOT, "public", "matches.json");
const OUTPUT_CURRENT = path.join(ROOT, "public", "points-leaderboard.json");
const OUTPUT_PREVIOUS = path.join(ROOT, "public", "points-leaderboard.previous.json");

// Add a new month here when the month changes.
const MONTH_START_BLOCKS = {
  "2026-02": 22080000,
  "2026-03": 22266000,
};

const SCORING = {
  first: 3,
  second: 2,
  third: 1,
  round1Exit: 0.5,
};

function normalizeAddress(addr) {
  return typeof addr === "string" ? addr.toLowerCase() : null;
}

function comparePlayers(a, b) {
  return (
    b.points - a.points ||
    b.firsts - a.firsts ||
    b.seconds - a.seconds ||
    b.thirds - a.thirds ||
    b.round1Exits - a.round1Exits ||
    a.wallet.localeCompare(b.wallet)
  );
}

function monthKeyFromDateUtc(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthKeyOffsetUtc(baseDate, offsetMonths) {
  const d = new Date(Date.UTC(baseDate.getUTCFullYear(), baseDate.getUTCMonth() + offsetMonths, 1));
  return monthKeyFromDateUtc(d);
}

function leagueLabelFromKey(key) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1, 1));
  const month = d.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  return `${month} League Points`;
}

function getOrCreatePlayer(map, wallet) {
  const key = normalizeAddress(wallet);
  if (!key) return null;

  if (!map.has(key)) {
    map.set(key, {
      wallet: key,
      points: 0,
      firsts: 0,
      seconds: 0,
      thirds: 0,
      round1Exits: 0,
      tournamentsCounted: 0,
      tournamentIds: [],
      firstIds: [],
      secondIds: [],
      thirdIds: [],
      fourthIds: [],
    });
  }

  return map.get(key);
}

function award(player, tournamentId, bucket, points) {
  if (!player) return;
  player.points += points;
  player[bucket] += 1;
  player.tournamentsCounted += 1;
  player.tournamentIds.push(tournamentId);

  if (bucket === "firsts") player.firstIds.push(tournamentId);
  if (bucket === "seconds") player.secondIds.push(tournamentId);
  if (bucket === "thirds") player.thirdIds.push(tournamentId);
  if (bucket === "round1Exits") player.fourthIds.push(tournamentId);
}

function otherPlayer(match, winner) {
  const a = normalizeAddress(match?.playerA);
  const b = normalizeAddress(match?.playerB);
  const w = normalizeAddress(winner);

  if (!a || !b || !w) return null;
  if (w === a) return b;
  if (w === b) return a;
  return null;
}

function buildRound1LosersByTournament(matchesPayload) {
  const rows = Array.isArray(matchesPayload?.matches) ? matchesPayload.matches : [];
  const grouped = new Map();

  for (const row of rows) {
    const matchId = row?.matchId;
    if (matchId == null) continue;
    if (!grouped.has(matchId)) grouped.set(matchId, []);
    grouped.get(matchId).push(row);
  }

  const out = new Map();

  for (const [matchId, tourneyRows] of grouped.entries()) {
    const validRows = tourneyRows.filter((r) => Number.isFinite(Number(r?.resultCode)));
    if (!validRows.length) continue;

    const minCode = Math.min(...validRows.map((r) => Number(r.resultCode)));
    const round1Rows = validRows.filter((r) => Number(r.resultCode) === minCode);

    const losers = [...new Set(
      round1Rows
        .map((r) => otherPlayer(r, r?.winner))
        .filter(Boolean)
    )];

    out.set(Number(matchId), losers);
  }

  return out;
}

function buildLeaderboardForRange({
  tournaments,
  round1LosersByTournament,
  resultsSummary,
  leagueKey,
  leagueLabel,
  startBlock,
  endBlockExclusive,
  previousLeagueLabel,
  previousAvailable,
}) {
  const players = new Map();

  let tournamentsSeen = 0;
  let tournamentsUsed = 0;
  let tournamentsSkipped = 0;
  let skippedBeforeLeagueStart = 0;
  let skippedAtOrAfterLeagueEnd = 0;
  let skippedIncomplete = 0;
  let skippedMissingPlacements = 0;
  let round1EligibleTournaments = 0;
  let round1Awards = 0;

  for (const t of tournaments) {
    tournamentsSeen += 1;

    const tournamentId = Number(t?.tournamentId);
    const status = t?.status ?? "unknown";
    const placements = t?.placements ?? {};
    const bracketSize = Number(t?.bracketSize || 0);
    const blockNumber = Number(t?.final?.blockNumber || t?.blockNumber || 0);

    if (blockNumber && blockNumber < startBlock) {
      tournamentsSkipped += 1;
      skippedBeforeLeagueStart += 1;
      continue;
    }

    if (Number.isFinite(endBlockExclusive) && blockNumber && blockNumber >= endBlockExclusive) {
      tournamentsSkipped += 1;
      skippedAtOrAfterLeagueEnd += 1;
      continue;
    }

    if (status !== "complete") {
      tournamentsSkipped += 1;
      skippedIncomplete += 1;
      continue;
    }

    const first = normalizeAddress(placements.first);
    const second = normalizeAddress(placements.second);
    const thirds = Array.isArray(placements.thirds)
      ? [...new Set(placements.thirds.map(normalizeAddress).filter(Boolean))]
      : [];

    if (!first || !second || thirds.length === 0) {
      tournamentsSkipped += 1;
      skippedMissingPlacements += 1;
      continue;
    }

    tournamentsUsed += 1;

    award(getOrCreatePlayer(players, first), tournamentId, "firsts", SCORING.first);
    award(getOrCreatePlayer(players, second), tournamentId, "seconds", SCORING.second);

    for (const wallet of thirds) {
      award(getOrCreatePlayer(players, wallet), tournamentId, "thirds", SCORING.third);
    }

    if (bracketSize >= 5) {
      round1EligibleTournaments += 1;

      const round1Losers = round1LosersByTournament.get(tournamentId) || [];
      const excluded = new Set([first, second, ...thirds].filter(Boolean));

      for (const wallet of round1Losers) {
        if (!wallet || excluded.has(wallet)) continue;
        award(getOrCreatePlayer(players, wallet), tournamentId, "round1Exits", SCORING.round1Exit);
        round1Awards += 1;
      }
    }
  }

  const ranked = [...players.values()]
    .map((p) => ({
      ...p,
      points: Number(p.points.toFixed(4)),
      fourthPoints: Number((p.round1Exits * SCORING.round1Exit).toFixed(4)),
    }))
    .sort(comparePlayers)
    .map((p, idx) => ({
      rank: idx + 1,
      wallet: p.wallet,
      points: p.points,
      firsts: p.firsts,
      seconds: p.seconds,
      thirds: p.thirds,
      round1Exits: p.round1Exits,
      fourthPoints: p.fourthPoints,
      tournamentsCounted: p.tournamentsCounted,
      tournamentIds: p.tournamentIds,
      firstIds: p.firstIds,
      secondIds: p.secondIds,
      thirdIds: p.thirdIds,
      fourthIds: p.fourthIds,
    }));

  return {
    updatedAtUtc: new Date().toISOString(),
    sourceFiles: [
      "public/tournament-results.json",
      "public/matches.json",
    ],
    sourceSummary: resultsSummary ?? null,
    scoring: SCORING,
    summary: {
      leagueKey,
      leagueLabel,
      previousLeagueLabel: previousLeagueLabel || null,
      previousAvailable: !!previousAvailable,
      startBlock,
      endBlockExclusive: Number.isFinite(endBlockExclusive) ? endBlockExclusive : null,
      tournamentsSeen,
      tournamentsUsed,
      tournamentsSkipped,
      skippedBeforeLeagueStart,
      skippedAtOrAfterLeagueEnd,
      skippedIncomplete,
      skippedMissingPlacements,
      round1EligibleTournaments,
      round1Awards,
      playersRanked: ranked.length,
      scoringRule: "1st=3, 2nd=2, tied 3rd=1 each, 4th=0.5 for tournaments with 5+ players",
      fourthDefinition: "4th is shown as exact points earned from round-1 exits (count × 0.5).",
    },
    players: ranked,
  };
}

function main() {
  if (!fs.existsSync(RESULTS_INPUT)) {
    throw new Error(`Missing input file: ${RESULTS_INPUT}`);
  }
  if (!fs.existsSync(MATCHES_INPUT)) {
    throw new Error(`Missing input file: ${MATCHES_INPUT}`);
  }

  const resultsParsed = JSON.parse(fs.readFileSync(RESULTS_INPUT, "utf8"));
  const matchesParsed = JSON.parse(fs.readFileSync(MATCHES_INPUT, "utf8"));

  const tournaments = Array.isArray(resultsParsed.tournaments) ? resultsParsed.tournaments : [];
  const round1LosersByTournament = buildRound1LosersByTournament(matchesParsed);

  const now = new Date();
  const currentKey = monthKeyFromDateUtc(now);
  const previousKey = monthKeyOffsetUtc(now, -1);
  const nextKey = monthKeyOffsetUtc(now, 1);

  const currentStart = MONTH_START_BLOCKS[currentKey];
  if (!Number.isFinite(currentStart)) {
    throw new Error(
      `No league start block configured for ${currentKey}. Add it to MONTH_START_BLOCKS in scripts/build-points-leaderboard.js`
    );
  }

  const nextStart = MONTH_START_BLOCKS[nextKey];
  const previousStart = MONTH_START_BLOCKS[previousKey];

  const currentOutput = buildLeaderboardForRange({
    tournaments,
    round1LosersByTournament,
    resultsSummary: resultsParsed.summary,
    leagueKey: currentKey,
    leagueLabel: leagueLabelFromKey(currentKey),
    startBlock: currentStart,
    endBlockExclusive: Number.isFinite(nextStart) ? nextStart : Infinity,
    previousLeagueLabel: Number.isFinite(previousStart) ? leagueLabelFromKey(previousKey) : null,
    previousAvailable: Number.isFinite(previousStart),
  });

  fs.mkdirSync(path.dirname(OUTPUT_CURRENT), { recursive: true });
  fs.writeFileSync(OUTPUT_CURRENT, JSON.stringify(currentOutput, null, 2));

  console.log(`Wrote ${OUTPUT_CURRENT}`);
  console.log(`League: ${currentOutput.summary.leagueLabel}`);
  console.log(`Start block: ${currentOutput.summary.startBlock}`);
  console.log(`Tournaments used: ${currentOutput.summary.tournamentsUsed}`);
  console.log(`Players ranked: ${currentOutput.summary.playersRanked}`);

  if (Number.isFinite(previousStart)) {
    const previousOutput = buildLeaderboardForRange({
      tournaments,
      round1LosersByTournament,
      resultsSummary: resultsParsed.summary,
      leagueKey: previousKey,
      leagueLabel: leagueLabelFromKey(previousKey),
      startBlock: previousStart,
      endBlockExclusive: currentStart,
      previousLeagueLabel: null,
      previousAvailable: false,
    });

    fs.writeFileSync(OUTPUT_PREVIOUS, JSON.stringify(previousOutput, null, 2));
    console.log(`Wrote ${OUTPUT_PREVIOUS}`);
    console.log(`Previous league: ${previousOutput.summary.leagueLabel}`);
    console.log(`Previous tournaments used: ${previousOutput.summary.tournamentsUsed}`);
  } else if (fs.existsSync(OUTPUT_PREVIOUS)) {
    fs.unlinkSync(OUTPUT_PREVIOUS);
  }

  console.log("");
  console.log("Top 10:");
  for (const p of currentOutput.players.slice(0, 10)) {
    console.log(
      `#${p.rank} ${p.wallet} | points=${p.points} | 1st=${p.firsts} | 2nd=${p.seconds} | 3rd=${p.thirds} | 4th=${p.fourthPoints}`
    );
  }
}

main();
