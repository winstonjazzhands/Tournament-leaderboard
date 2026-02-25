#!/usr/bin/env node
/**
 * Validate public JSON data for the DFK Tournament Leaderboard site.
 *
 * Usage:
 *   node scripts/validate-public-data.js
 *
 * Exits:
 *   0 = OK (or only minor warnings)
 *   1 = Serious issues found
 */

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");

const FILES = {
  leaderboard: path.join(PUBLIC, "leaderboard.json"),
  profiles: path.join(PUBLIC, "profiles.json"),
  ranges: path.join(PUBLIC, "tournamentRanges.json"),
};

function readJson(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`Invalid JSON in ${filePath}: ${e.message}`);
  }
}

function isHexWallet(s) {
  return typeof s === "string" && /^0x[a-fA-F0-9]{40}$/.test(s);
}

function toLowerWallet(s) {
  return typeof s === "string" ? s.toLowerCase() : s;
}

function isInt(n) {
  return Number.isInteger(n);
}

function nowUnix() {
  return Math.floor(Date.now() / 1000);
}

function summarizeList(list, max = 15) {
  if (list.length <= max) return list;
  return list.slice(0, max).concat([`...and ${list.length - max} more`]);
}

function main() {
  const issues = [];
  const warnings = [];

  // --- Load files ---
  let wins, profiles, ranges;
  for (const [k, fp] of Object.entries(FILES)) {
    if (!fs.existsSync(fp)) {
      issues.push(`Missing required file: ${fp}`);
    }
  }
  if (issues.length) return finish(issues, warnings);

  wins = readJson(FILES.leaderboard);
  profiles = readJson(FILES.profiles);
  ranges = readJson(FILES.ranges);

  // --- Basic type checks ---
  if (!Array.isArray(wins)) issues.push("leaderboard.json must be a JSON array.");
  if (typeof profiles !== "object" || profiles === null || Array.isArray(profiles))
    issues.push("profiles.json must be a JSON object (wallet -> profile).");
  if (typeof ranges !== "object" || ranges === null || Array.isArray(ranges))
    issues.push("tournamentRanges.json must be a JSON object (tournamentId -> range).");

  if (issues.length) return finish(issues, warnings);

  // --- Validate profiles keys ---
  const badProfileKeys = [];
  for (const key of Object.keys(profiles)) {
    if (!isHexWallet(key)) badProfileKeys.push(key);
    if (key !== key.toLowerCase()) warnings.push(`profiles.json key not lowercase: ${key}`);
    const p = profiles[key];
    if (!p || typeof p !== "object") {
      issues.push(`profiles.json value for ${key} must be an object.`);
      continue;
    }
    if (typeof p.name !== "string" || !p.name.trim()) {
      warnings.push(`profiles.json missing/blank name for ${key}`);
    }
  }
  if (badProfileKeys.length) {
    issues.push(`profiles.json has invalid wallet keys: ${summarizeList(badProfileKeys).join(", ")}`);
  }

  // --- Validate ranges entries ---
  const badRangeKeys = [];
  const badRangeValues = [];
  for (const [tid, r] of Object.entries(ranges)) {
    const tidStr = String(tid);
    if (tidStr !== tid) {
      // keys in JS objects are already strings; this is just informational
    }
    if (!r || typeof r !== "object") {
      badRangeValues.push(tidStr);
      continue;
    }
    const { minLevel, maxLevel } = r;
    if (typeof minLevel !== "number" || typeof maxLevel !== "number") badRangeValues.push(tidStr);
    if (
      typeof minLevel === "number" &&
      typeof maxLevel === "number" &&
      (minLevel > maxLevel || minLevel < 1 || maxLevel > 200)
    ) {
      badRangeValues.push(tidStr);
    }
  }
  if (badRangeKeys.length) issues.push(`tournamentRanges.json has invalid tournamentId keys.`);
  if (badRangeValues.length)
    issues.push(
      `tournamentRanges.json has invalid range objects for: ${summarizeList(badRangeValues).join(", ")}`
    );

  // --- Validate wins ---
  const badWallets = [];
  const badTimestamps = [];
  const badTournamentIds = [];
  const missingRangeTournamentIds = new Set();
  const tierMismatch = [];
  const dedupeKeySet = new Set();
  const dupes = [];

  const now = nowUnix();

  // Track coverage and name hit rate
  const tournamentIdSet = new Set();
  let profileHits = 0;

  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (!w || typeof w !== "object") {
      issues.push(`leaderboard.json item at index ${i} is not an object.`);
      continue;
    }

    const wallet = w.wallet;
    const timestamp = w.timestamp;
    const tournamentId = w.tournamentId;

    if (!isHexWallet(wallet)) badWallets.push(`idx${i}:${String(wallet)}`);
    if (typeof timestamp !== "number" || !isInt(timestamp) || timestamp < 1400000000 || timestamp > now + 3600)
      badTimestamps.push(`idx${i}:${String(timestamp)}`);

    if (tournamentId === undefined || tournamentId === null || String(tournamentId).trim() === "")
      badTournamentIds.push(`idx${i}:${String(tournamentId)}`);

    const walletLower = toLowerWallet(wallet);
    if (profiles[walletLower] && typeof profiles[walletLower].name === "string" && profiles[walletLower].name.trim()) {
      profileHits++;
    }

    const tid = String(tournamentId);
    tournamentIdSet.add(tid);

    // Coverage check
    const range = ranges[tid];
    if (!range) {
      missingRangeTournamentIds.add(tid);
    } else {
      // optional: detect mismatch between unreliable win.tier and override tier
      // only if both are present
      if (w.tier !== undefined && range.tier !== undefined && String(w.tier) !== String(range.tier)) {
        tierMismatch.push(`tid ${tid} win.tier=${w.tier} override=${range.tier}`);
      }
    }

    // Dedupe check (best-effort)
    const dedupeKey = `${walletLower}|${tid}|${timestamp}`;
    if (dedupeKeySet.has(dedupeKey)) dupes.push(dedupeKey);
    dedupeKeySet.add(dedupeKey);
  }

  if (badWallets.length)
    issues.push(`Invalid wallet(s) in leaderboard.json: ${summarizeList(badWallets).join(", ")}`);
  if (badTimestamps.length)
    issues.push(`Invalid timestamp(s) in leaderboard.json: ${summarizeList(badTimestamps).join(", ")}`);
  if (badTournamentIds.length)
    issues.push(`Missing/invalid tournamentId(s) in leaderboard.json: ${summarizeList(badTournamentIds).join(", ")}`);

  if (dupes.length) warnings.push(`Possible duplicate wins detected (wallet|tournamentId|timestamp): ${summarizeList(dupes).join(", ")}`);

  // Coverage is important
  if (missingRangeTournamentIds.size) {
    issues.push(
      `Missing tournamentRanges entries for tournamentId(s): ${summarizeList([...missingRangeTournamentIds]).join(", ")}`
    );
  }

  // Mismatch is expected sometimes, but report it
  if (tierMismatch.length) {
    warnings.push(
      `Tier mismatch (expected because leaderboard tier is unreliable). Examples: ${summarizeList(tierMismatch).join(" | ")}`
    );
  }

  // Name hit rate
  const hitRate = wins.length ? (profileHits / wins.length) * 100 : 100;
  warnings.push(`Profile name hit rate: ${profileHits}/${wins.length} (${hitRate.toFixed(1)}%)`);

  // --- Print summary ---
  finish(issues, warnings);
}

function finish(issues, warnings) {
  console.log("======================================");
  console.log("DFK Leaderboard Data Validation Report");
  console.log("======================================\n");

  if (issues.length) {
    console.log("❌ ISSUES (must fix):");
    for (const s of issues) console.log(`- ${s}`);
    console.log("");
  } else {
    console.log("✅ No serious issues found.\n");
  }

  if (warnings.length) {
    console.log("⚠️ WARNINGS (review):");
    for (const s of warnings) console.log(`- ${s}`);
    console.log("");
  }

  if (issues.length) process.exit(1);
  process.exit(0);
}

main();