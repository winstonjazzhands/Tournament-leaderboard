#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");

// Default match topic0 for extracting tournament matches.
// Can be overridden with env MATCH_TOPIC0.
const DEFAULT_MATCH_TOPIC0 =
  "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait (fine for short backoffs in CI)
  }
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function childOpts(extraEnv = {}) {
  return {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...extraEnv },
  };
}

function run(cmd, args, extraEnv = {}) {
  const r = spawnSync(cmd, args, childOpts(extraEnv));
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runWithRetry(cmd, args, { attempts = 5, baseDelayMs = 1500, extraEnv = {} } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const r = spawnSync(cmd, args, childOpts(extraEnv));

    if (r.status === 0) return;

    if (i === attempts) {
      process.exit(r.status ?? 1);
    }

    const delay = baseDelayMs * Math.pow(2, i - 1);
    console.log(`Step failed (attempt ${i}/${attempts}). Retrying in ${Math.round(delay)}ms...`);
    sleepSync(delay);
  }
}

function runScript(scriptPath, opts = {}) {
  const {
    retry = false,
    attempts = 5,
    baseDelayMs = 1500,
    args = [],
    extraEnv = {},
  } = opts;

  if (!exists(scriptPath)) {
    console.log(`Skip missing script: ${scriptPath}`);
    return false;
  }

  console.log(`Running: ${scriptPath}${args.length ? " " + args.join(" ") : ""}`);
  if (retry) {
    runWithRetry("node", [scriptPath, ...args], { attempts, baseDelayMs, extraEnv });
  } else {
    run("node", [scriptPath, ...args], extraEnv);
  }
  return true;
}

function runFirstExisting(candidates, opts = {}) {
  for (const scriptPath of candidates) {
    if (exists(scriptPath)) {
      return runScript(scriptPath, opts);
    }
  }
  console.log(`Skip optional step, no matching script found: ${candidates.join(", ")}`);
  return false;
}

function copyIfExists(src, dst) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Copied: ${src} -> ${dst}`);
  } else {
    console.log(`Skip copy (missing): ${src}`);
  }
}

function copyPublicToRootIfExists(fileName) {
  copyIfExists(path.join(PUBLIC_DIR, fileName), path.join(ROOT, fileName));
}

function main() {
  const matchTopic0 = process.env.MATCH_TOPIC0 || DEFAULT_MATCH_TOPIC0;

  console.log("update-all RPC_URL exists:", !!process.env.RPC_URL);
  console.log("update-all MATCH_TOPIC0:", matchTopic0);

  runScript("scripts/pull-wins-tier-from-logs-post22m-lookback.js", {
    retry: true,
    attempts: 6,
    baseDelayMs: 2000,
  });

  runFirstExisting([
    "scripts/resolve-profiles-community-api.js",
    "scripts/resolve-profiles-metis.js",
  ]);

  runFirstExisting([
    "scripts/build-tournamentRanges-subgraph.js",
    "scripts/build-tournamentRanges.js",
  ]);

  runFirstExisting([
    "scripts/apply-tournament-ranges-to-leaderboard.js",
    "scripts/apply-ranges-to-leaderboard.js",
  ]);

  // Refresh the inputs that the points leaderboard actually reads.
  runFirstExisting([
    "scripts/extract-matches-from-topic0.js",
  ], {
    args: [matchTopic0],
    retry: true,
    attempts: 3,
    baseDelayMs: 1500,
  });

  runFirstExisting([
    "scripts/build-tournament-results.js",
  ]);

  runFirstExisting([
    "scripts/build-points-leaderboard.js",
    "scripts/build-monthly-points-leaderboard.js",
    "scripts/update-points-leaderboard.js",
    "scripts/generate-points-leaderboard.js",
    "scripts/build-league-points.js",
    "scripts/update-league-points.js",
    "scripts/build-points.js",
    "scripts/update-points.js",
  ]);

  runFirstExisting([
    "scripts/validate-public-data.js",
    "scripts/validate-data.js",
  ]);

  copyPublicToRootIfExists("leaderboard.json");
  copyPublicToRootIfExists("profiles.json");
  copyPublicToRootIfExists("tournamentRanges.json");
  copyPublicToRootIfExists("matches.json");
  copyPublicToRootIfExists("tournament-results.json");

  [
    "pointsLeaderboard.json",
    "points-leaderboard.json",
    "points-leaderboard.previous.json",
    "monthlyPointsLeaderboard.json",
    "monthly-points-leaderboard.json",
    "leaguePoints.json",
    "league-points.json",
    "points.json",
  ].forEach(copyPublicToRootIfExists);

  console.log("update-all complete.");
}

main();
