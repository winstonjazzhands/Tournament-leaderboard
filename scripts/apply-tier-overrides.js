// scripts/apply-tier-overrides.js
// Usage examples:
//   node scripts/apply-tier-overrides.js 2044=20
//   node scripts/apply-tier-overrides.js 2044=20 2045=10
//
// It edits: public/leaderboard.json
// It updates any win rows whose tournamentId matches the override(s).

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// project root is parent of /scripts
const ROOT = path.resolve(__dirname, "..");
const LEADERBOARD_PATH = path.join(ROOT, "public", "leaderboard.json");

function parseOverrides(argv) {
  // accepts args like 2044=20
  const overrides = new Map();

  for (const raw of argv) {
    const m = String(raw).match(/^(\d+)\s*=\s*(10|20)$/);
    if (!m) {
      console.error(`Bad override "${raw}". Use format like 2044=20`);
      process.exit(1);
    }
    overrides.set(String(Number(m[1])), Number(m[2]));
  }

  if (overrides.size === 0) {
    console.error("No overrides provided. Example: node scripts/apply-tier-overrides.js 2044=20");
    process.exit(1);
  }

  return overrides;
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

function normalizeTourneyId(win) {
  // tolerate a few possible keys
  const tid =
    win.tournamentId ??
    win.tourneyId ??
    win.tournament ??
    win.tournamentID ??
    win.id;

  if (tid === null || tid === undefined) return null;

  // if it's numeric already, stringify it.
  if (typeof tid === "number") return String(tid);

  // if it's a string, try to extract digits (handles weird cases)
  const s = String(tid).trim();
  const digits = s.match(/\d+/g);
  if (!digits) return s;
  // if the string is purely digits, keep it. otherwise keep the last digit group.
  return /^\d+$/.test(s) ? s : digits[digits.length - 1];
}

function main() {
  const overrides = parseOverrides(process.argv.slice(2));

  if (!fs.existsSync(LEADERBOARD_PATH)) {
    console.error(`Can't find ${LEADERBOARD_PATH}`);
    process.exit(1);
  }

  const data = readJson(LEADERBOARD_PATH);
  const wins = Array.isArray(data.wins) ? data.wins : [];

  let touched = 0;
  let changed = 0;

  for (const w of wins) {
    const tid = normalizeTourneyId(w);
    if (!tid) continue;

    if (overrides.has(tid)) {
      touched++;
      const newTier = overrides.get(tid);
      const oldTier = w.tier;

      if (oldTier !== newTier) {
        w.tier = newTier;
        changed++;
      }
    }
  }

  // Optional: stamp metadata
  data.updatedAtUtc = new Date().toISOString();
  data.tierOverridesApplied = Object.fromEntries(overrides.entries());

  writeJson(LEADERBOARD_PATH, data);

  console.log(`Patched ${LEADERBOARD_PATH}`);
  console.log(`Overrides: ${JSON.stringify(Object.fromEntries(overrides.entries()))}`);
  console.log(`Matched rows: ${touched} | Changed tier: ${changed}`);
}

main();