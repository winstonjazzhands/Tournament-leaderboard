#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();
const INPUT = path.join(ROOT, "public", "matches.json");
const OUTPUT = path.join(ROOT, "public", "tournament-results.json");

// Result code meaning inferred from your data:
// 1-4 = quarterfinals / early round
// 5   = semifinal A
// 6   = semifinal B
// 7   = final
const FINAL_CODE = 7;
const SEMI_CODES = new Set([5, 6]);

function short(addr) {
  if (!addr) return null;
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function normalizeAddress(addr) {
  return typeof addr === "string" ? addr.toLowerCase() : null;
}

function unique(arr) {
  return [...new Set(arr)];
}

function otherPlayer(match, winner) {
  const a = normalizeAddress(match.playerA);
  const b = normalizeAddress(match.playerB);
  const w = normalizeAddress(winner);

  if (!w) return null;
  if (w === a) return b;
  if (w === b) return a;
  return null;
}

function detectBracketSize(matches) {
  const uniquePlayers = unique(
    matches.flatMap((m) => [normalizeAddress(m.playerA), normalizeAddress(m.playerB)]).filter(Boolean)
  );
  return uniquePlayers.length;
}

function sortMatchesChronologically(matches) {
  return [...matches].sort((a, b) => {
    if ((a.blockNumber ?? 0) !== (b.blockNumber ?? 0)) {
      return (a.blockNumber ?? 0) - (b.blockNumber ?? 0);
    }
    return (a.logIndex ?? 0) - (b.logIndex ?? 0);
  });
}

function buildTournamentResult(matchId, matches) {
  const ordered = sortMatchesChronologically(matches);
  const bracketSize = detectBracketSize(ordered);

  const finalMatch = ordered.find((m) => m.resultCode === FINAL_CODE);
  const semiMatches = ordered.filter((m) => SEMI_CODES.has(m.resultCode));

  const issues = [];

  if (!finalMatch) {
    issues.push("Missing final match (resultCode 7).");
  }

  if (semiMatches.length === 0) {
    issues.push("No semifinal matches found (resultCode 5/6).");
  }

  const finalWinner = normalizeAddress(finalMatch?.winner);
  const first = finalWinner || null;
  const second = finalMatch && finalWinner ? otherPlayer(finalMatch, finalWinner) : null;

  if (finalMatch && !finalWinner) {
    issues.push("Final winner is null. Winner decoder likely still broken.");
  }

  const semifinalLosers = semiMatches
    .map((m) => {
      const winner = normalizeAddress(m.winner);
      if (!winner) {
        issues.push(`Semifinal resultCode ${m.resultCode} winner is null.`);
        return null;
      }

      const loser = otherPlayer(m, winner);
      if (!loser) {
        issues.push(`Could not determine loser for semifinal resultCode ${m.resultCode}.`);
        return null;
      }

      return loser;
    })
    .filter(Boolean);

  const thirds = unique(semifinalLosers);

  // In standard single elimination with no bronze match, semifinal losers are tied for 3rd.
  const hasUniqueThird = thirds.length === 1;

  return {
    tournamentId: Number(matchId),
    bracketSize,
    totalMatches: ordered.length,
    placements: {
      first,
      second,
      // Keep both because your current match data does not include a unique bronze match.
      thirds,
      hasUniqueThird,
    },
    final: finalMatch
      ? {
          resultCode: finalMatch.resultCode,
          winner: normalizeAddress(finalMatch.winner),
          loser: second,
          playerA: normalizeAddress(finalMatch.playerA),
          playerB: normalizeAddress(finalMatch.playerB),
          blockNumber: finalMatch.blockNumber ?? null,
          txHash: finalMatch.txHash ?? null,
        }
      : null,
    semifinals: semiMatches.map((m) => {
      const winner = normalizeAddress(m.winner);
      return {
        resultCode: m.resultCode,
        winner,
        loser: winner ? otherPlayer(m, winner) : null,
        playerA: normalizeAddress(m.playerA),
        playerB: normalizeAddress(m.playerB),
        blockNumber: m.blockNumber ?? null,
        txHash: m.txHash ?? null,
      };
    }),
    status: issues.length ? "incomplete" : "complete",
    issues,
  };
}

async function main() {
  const raw = await fs.readFile(INPUT, "utf8");
  const parsed = JSON.parse(raw);

  const matches = Array.isArray(parsed.matches) ? parsed.matches : [];
  if (!matches.length) {
    throw new Error(`No matches found in ${INPUT}`);
  }

  const grouped = new Map();
  for (const row of matches) {
    const id = row.matchId;
    if (id === undefined || id === null) continue;
    if (!grouped.has(id)) grouped.set(id, []);
    grouped.get(id).push({
      ...row,
      playerA: normalizeAddress(row.playerA),
      playerB: normalizeAddress(row.playerB),
      winner: normalizeAddress(row.winner),
    });
  }

  const tournaments = [...grouped.entries()]
    .map(([matchId, rows]) => buildTournamentResult(matchId, rows))
    .sort((a, b) => a.tournamentId - b.tournamentId);

  const summary = {
    generatedAtUtc: new Date().toISOString(),
    sourceFile: "public/matches.json",
    sourceUpdatedAtUtc: parsed.updatedAtUtc ?? null,
    totalTournaments: tournaments.length,
    completeTournaments: tournaments.filter((t) => t.status === "complete").length,
    incompleteTournaments: tournaments.filter((t) => t.status !== "complete").length,
    notes: [
      "This file reconstructs tournament placements from matches.json.",
      "Current match data appears to use resultCode 7 as final and 5/6 as semifinals.",
      "Third place is represented as tied semifinal losers unless a bronze-match source is added later.",
    ],
  };

  const output = {
    summary,
    tournaments,
  };

  await fs.writeFile(OUTPUT, JSON.stringify(output, null, 2), "utf8");

  console.log(`Wrote ${OUTPUT}`);
  console.log(`Total tournaments: ${summary.totalTournaments}`);
  console.log(`Complete: ${summary.completeTournaments}`);
  console.log(`Incomplete: ${summary.incompleteTournaments}`);

  const sampleIncomplete = tournaments.find((t) => t.status !== "complete");
  if (sampleIncomplete) {
    console.log("");
    console.log("Example incomplete tournament:");
    console.log(
      JSON.stringify(
        {
          tournamentId: sampleIncomplete.tournamentId,
          status: sampleIncomplete.status,
          issues: sampleIncomplete.issues,
          placements: sampleIncomplete.placements,
        },
        null,
        2
      )
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});