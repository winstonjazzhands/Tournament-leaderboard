// scripts/update-all.js
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function run(cmd) {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: "inherit", shell: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeTournamentRangesStub(publicDir) {
  const outPath = path.join(publicDir, "tournamentRanges.json");

  // If it already exists, do nothing
  if (fs.existsSync(outPath)) return;

  const stub = {
    updatedAtUtc: new Date().toISOString(),
    source: "stub (tournamentRanges build failed)",
    rangesByTournamentId: {},
  };

  fs.writeFileSync(outPath, JSON.stringify(stub, null, 2) + "\n", "utf8");
  console.log(`⚠️  Wrote stub tournamentRanges.json -> ${outPath}`);
}

const PUBLIC_DIR = path.resolve("public");
ensureDir(PUBLIC_DIR);

try {
  // 1) Wins
  run("node scripts/pull-wins-tier-from-logs-post22m-lookback.js");

  // 2) Profiles
  run("node scripts/resolve-profiles-community-api.js");

  // 3) Tournament ranges (allowed to fail)
  try {
    run("node scripts/build-tournamentRanges-subgraph.js");
  } catch (e) {
    console.log("\n⚠️ tournamentRanges build FAILED (continuing)");
    writeTournamentRangesStub(PUBLIC_DIR);
  }

  // If build script failed before creating file, ensure stub exists anyway
  writeTournamentRangesStub(PUBLIC_DIR);

  // 4) Validate (now it should always have required files)
  run("node scripts/validate-public-data.js");

  console.log("\n✅ update-all finished.");
} catch (err) {
  console.error("\n❌ update-all failed.");
  process.exitCode = 1;
}