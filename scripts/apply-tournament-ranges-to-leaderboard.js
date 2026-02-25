/**
 * Apply /public/tournamentRanges.json to /public/leaderboard.json
 * and write /public/leaderboard.json back with corrected win.tier values.
 *
 * Rule:
 *   if maxLevel >= 16 => tier = 20 else tier = 10
 *
 * Usage:
 *   node scripts/apply-tournament-ranges-to-leaderboard.js
 */
import path from "path";
import { readJson, writeJson } from "./utils.js";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const LEADERBOARD_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const RANGES_PATH = path.join(PUBLIC_DIR, "tournamentRanges.json");

function deriveTier(range) {
  const maxLevel = Number(range?.maxLevel ?? range?.max ?? range?.max_level);
  if (!Number.isFinite(maxLevel)) return null;
  return maxLevel >= 16 ? 20 : 10;
}

function main() {
  const leaderboard = readJson(LEADERBOARD_PATH);
  const rangesDoc = readJson(RANGES_PATH);

  if (!leaderboard?.wins?.length) {
    console.error("Expected public/leaderboard.json with wins[]");
    process.exit(1);
  }
  const ranges = rangesDoc?.ranges ?? {};
  const beforeBad = [];

  let changed = 0;
  for (const w of leaderboard.wins) {
    const tid = String(w.tournamentId ?? w.tournament_id ?? w.tournament ?? "");
    const r = ranges[tid];
    if (!r) continue;
    const tier = deriveTier(r);
    if (!tier) continue;

    const prev = Number(w.tier ?? 0) || 0;
    if (prev && prev !== tier) beforeBad.push({ tournamentId: tid, prev, next: tier });
    if (prev !== tier) {
      w.tier = tier;
      changed += 1;
    }
  }

  leaderboard.tiersUpdatedAtUtc = new Date().toISOString();
  leaderboard.tiersSource = rangesDoc?.source ?? "tournamentRanges.json";
  leaderboard.tiersChanges = changed;

  writeJson(LEADERBOARD_PATH, leaderboard);

  console.log(`Updated wins: ${changed}`);
  if (beforeBad.length) {
    console.log("Examples of changes (first 15):");
    console.log(beforeBad.slice(0, 15));
  }
  console.log(`Wrote ${LEADERBOARD_PATH}`);
}

main();
