#!/usr/bin/env node
/**
 * Update everything in the correct order, then always copy public outputs to repo root.
 *
 * Order:
 *   1) wins
 *   2) profiles
 *   3) ranges
 *   4) apply tiers
 *   5) validate
 *   6) copy public/*.json -> repo root
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function copyIfExists(src, dst) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, dst);
    console.log(`Copied: ${src} -> ${dst}`);
  } else {
    console.log(`Skip copy (missing): ${src}`);
  }
}

function main() {
  // Run the same scripts your package.json points to
  run("node", ["scripts/pull-wins-tier-from-logs-post22m-lookback.js"]);
  run("node", ["scripts/resolve-profiles-community-api.js"]);
  run("node", ["scripts/build-tournamentRanges-subgraph.js"]);
  run("node", ["scripts/apply-tournament-ranges-to-leaderboard.js"]);
  run("node", ["scripts/validate-public-data.js"]);

  // Always keep repo root in sync for GitHub Pages root hosting
  copyIfExists(path.join(PUBLIC_DIR, "leaderboard.json"), path.join(ROOT, "leaderboard.json"));
  copyIfExists(path.join(PUBLIC_DIR, "profiles.json"), path.join(ROOT, "profiles.json"));
  copyIfExists(path.join(PUBLIC_DIR, "tournamentRanges.json"), path.join(ROOT, "tournamentRanges.json"));

  console.log("update-all complete.");
}

main();