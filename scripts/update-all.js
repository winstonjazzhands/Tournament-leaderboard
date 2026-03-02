#!/usr/bin/env node
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");

function sleepSync(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // busy wait (fine for short backoffs in CI)
  }
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function runWithRetry(cmd, args, { attempts = 5, baseDelayMs = 1500 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });

    if (r.status === 0) return;

    if (i === attempts) {
      process.exit(r.status ?? 1);
    }

    const delay = baseDelayMs * Math.pow(2, i - 1); // 1.5s, 3s, 6s, 12s, ...
    console.log(`Step failed (attempt ${i}/${attempts}). Retrying in ${Math.round(delay)}ms...`);
    sleepSync(delay);
  }
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
  // Retry the flaky subgraph-dependent step
  runWithRetry("node", ["scripts/pull-wins-tier-from-logs-post22m-lookback.js"], {
    attempts: 6,
    baseDelayMs: 2000,
  });

  run("node", ["scripts/resolve-profiles-community-api.js"]);
  run("node", ["scripts/build-tournamentRanges-subgraph.js"]);
  run("node", ["scripts/apply-tournament-ranges-to-leaderboard.js"]);
  run("node", ["scripts/validate-public-data.js"]);

  copyIfExists(path.join(PUBLIC_DIR, "leaderboard.json"), path.join(ROOT, "leaderboard.json"));
  copyIfExists(path.join(PUBLIC_DIR, "profiles.json"), path.join(ROOT, "profiles.json"));
  copyIfExists(path.join(PUBLIC_DIR, "tournamentRanges.json"), path.join(ROOT, "tournamentRanges.json"));

  console.log("update-all complete.");
}

main();