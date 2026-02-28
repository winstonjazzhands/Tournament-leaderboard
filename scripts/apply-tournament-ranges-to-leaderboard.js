#!/usr/bin/env node
/**
 * Apply /public/tournamentRanges.json to /public/leaderboard.json
 * and write /public/leaderboard.json back with corrected win.tier values.
 *
 * Rule:
 *   if maxLevel >= 20 => tier = 20 else tier = 10
 *
 * Also copies:
 *   public/leaderboard.json -> leaderboard.json (repo root)
 */

import fs from "fs";
import path from "path";
import { readJson, writeJson } from "./utils.js";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const LEADERBOARD_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const RANGES_PATH = path.join(PUBLIC_DIR, "tournamentRanges.json");
const ROOT_LEADERBOARD_COPY = path.join(ROOT, "leaderboard.json");

function deriveTier(range) {
  const maxLevel = Number(
    range?.maxLevel ??
      range?.max ??
      range?.max_level ??
      range?.maxHeroLevel ??
      range?.max_hero_level
  );
  if (!Number.isFinite(maxLevel)) return null;
  return maxLevel >= 20 ? 20 : 10;
}

function main() {
  const leaderboard = readJson(LEADERBOARD_PATH);
  const rangesDoc = readJson(RANGES_PATH);

  if (!leaderboard?.wins?.length) {
    console.error("Expected public/leaderboard.json with wins[]");
    process.exit(1);
  }

  // Support both shapes:
  // - { rangesByTournamentId: { [id]: {...} } }
  // - { ranges: { [id]: {...} } }
  const ranges = rangesDoc?.rangesByTournamentId ?? rangesDoc?.ranges ?? {};

  let changed = 0;
  const examples = [];

  for (const w of leaderboard.wins) {
    const tid = String(w.tournamentId ?? w.tournament_id ?? w.tournament ?? "");
    if (!tid) continue;

    const r = ranges[tid];
    if (!r) continue;

    const newTier = deriveTier(r);
    if (!newTier) continue;

    const prevTier = Number(w.tier ?? 0) || 0;

    if (prevTier !== newTier) {
      if (examples.length < 15) {
        examples.push({ tournamentId: tid, previous: prevTier, updatedTo: newTier });
      }
      w.tier = newTier;
      changed += 1;
    }
  }

  leaderboard.tiersUpdatedAtUtc = new Date().toISOString();
  leaderboard.tiersChanges = changed;

  writeJson(LEADERBOARD_PATH, leaderboard);

  // ✅ Keep repo root in sync for Pages/root consumers and your sanity
  fs.copyFileSync(LEADERBOARD_PATH, ROOT_LEADERBOARD_COPY);

  console.log(`Updated wins: ${changed}`);
  if (examples.length) {
    console.log("Examples of changes:");
    console.log(examples);
  }
  console.log(`Wrote: ${LEADERBOARD_PATH}`);
  console.log(`Copied: ${ROOT_LEADERBOARD_COPY}`);
}

main();