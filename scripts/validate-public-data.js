// scripts/validate-public-data.js
import fs from "node:fs";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function isObject(v) {
  return v && typeof v === "object" && !Array.isArray(v);
}

function pct(a, b) {
  if (!b) return "0.0";
  return ((a / b) * 100).toFixed(1);
}

const leaderboardPath = "public/leaderboard.json";
const profilesPath = "public/profiles.json";
const rangesPath = "public/tournamentRanges.json";

console.log("======================================");
console.log("DFK Leaderboard Data Validation Report");
console.log("======================================");

const issues = [];
const warnings = [];
const info = [];

// ---- Required: leaderboard.json ----
let leaderboard;
try {
  leaderboard = readJson(leaderboardPath);
} catch (e) {
  issues.push(`Missing/invalid JSON: ${leaderboardPath}`);
}

if (leaderboard) {
  if (!isObject(leaderboard) || !Array.isArray(leaderboard.wins)) {
    issues.push(`leaderboard.json format invalid (expected object with wins[])`);
  } else {
    info.push(`leaderboard.json format: object with wins[] (${leaderboard.wins.length} wins)`);
  }
}

// ---- Required: profiles.json ----
let profiles;
try {
  profiles = readJson(profilesPath);
} catch (e) {
  issues.push(`Missing/invalid JSON: ${profilesPath}`);
}

let namesByAddress = {};
if (profiles) {
  if (!isObject(profiles) || !isObject(profiles.namesByAddress)) {
    issues.push(`profiles.json format invalid (expected { namesByAddress: { [wallet]: string } })`);
  } else {
    namesByAddress = profiles.namesByAddress;
    info.push(`profiles.json format: wrapper namesByAddress (wallet->string) (${Object.keys(namesByAddress).length} entries)`);
  }
}

// ---- Optional / Best-effort: tournamentRanges.json ----
let ranges = null;
let rangesByTournamentId = {};
try {
  ranges = readJson(rangesPath);
  if (isObject(ranges) && isObject(ranges.rangesByTournamentId)) {
    rangesByTournamentId = ranges.rangesByTournamentId;
    info.push(
      `tournamentRanges.json format: wrapper rangesByTournamentId (${Object.keys(rangesByTournamentId).length} entries)`
    );
  } else {
    warnings.push(`tournamentRanges.json present but format unexpected (expected { rangesByTournamentId: {...} })`);
  }
} catch (e) {
  warnings.push(`tournamentRanges.json missing/invalid (continuing).`);
}

// ---- Cross-checks ----
if (leaderboard && Array.isArray(leaderboard.wins)) {
  // Profile hit rate
  let hits = 0;
  for (const w of leaderboard.wins) {
    const wallet = (w.wallet || "").toLowerCase();
    if (wallet && typeof namesByAddress[wallet] === "string" && namesByAddress[wallet].trim()) hits++;
  }
  info.push(`Profile name hit rate: ${hits}/${leaderboard.wins.length} (${pct(hits, leaderboard.wins.length)}%)`);

  // Missing tournamentRanges entries => WARN only (not fatal)
  const missing = [];
  for (const w of leaderboard.wins) {
    const tid = String(w.tournamentId);
    if (!rangesByTournamentId[tid]) missing.push(tid);
  }
  if (missing.length > 0) {
    warnings.push(
      `Missing tournamentRanges entries for ${missing.length} tournamentId(s) (example: ${missing.slice(0, 20).join(", ")}${
        missing.length > 20 ? ", ..." : ""
      })`
    );
  }
}

// ---- Print report ----
console.log("ℹ️ INFO:");
for (const s of info) console.log(`- ${s}`);

if (warnings.length) {
  console.log("⚠️ WARNINGS:");
  for (const s of warnings) console.log(`- ${s}`);
}

if (issues.length) {
  console.log("❌ ISSUES (must fix):");
  for (const s of issues) console.log(`- ${s}`);
  process.exitCode = 1;
} else {
  console.log("✅ No blocking issues.");
}