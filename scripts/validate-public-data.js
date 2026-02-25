#!/usr/bin/env node
/**
 * Validate public JSON data for the DFK Tournament Leaderboard site.
 *
 * Supports:
 * - leaderboard.json:
 *   - Win[]
 *   - { wins: Win[], ...meta }
 *
 * - profiles.json:
 *   - { [walletLower]: { name, ... } }
 *   - { namesByAddress: { [walletLower]: string }, ...meta }
 *
 * - tournamentRanges.json:
 *   - { [tournamentId]: { minLevel, maxLevel, tier?, ... } }
 *   - { rangesByTournamentId: { [tournamentId]: { minLevel, maxLevel, tier?, ... } }, ...meta }
 *
 * Usage:
 *   node scripts/validate-public-data.js
 *
 * Exits:
 *   0 = OK (or only minor warnings)
 *   1 = Serious issues found
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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

function isPlainObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function extractWins(leaderboardJson) {
  if (Array.isArray(leaderboardJson)) {
    return { wins: leaderboardJson, meta: null, format: "wins[] array" };
  }
  if (isPlainObject(leaderboardJson) && Array.isArray(leaderboardJson.wins)) {
    const { wins, ...meta } = leaderboardJson;
    return { wins, meta, format: "object with wins[]" };
  }
  return { wins: null, meta: null, format: "unknown" };
}

function extractProfiles(profilesJson) {
  // format A: direct map wallet->profileObject
  if (isPlainObject(profilesJson)) {
    const keys = Object.keys(profilesJson);

    // format B: wrapper with namesByAddress map of wallet->string
    if (isPlainObject(profilesJson.namesByAddress)) {
      const { namesByAddress, ...meta } = profilesJson;

      // Normalize into wallet->profileObject
      const map = {};
      for (const [wallet, name] of Object.entries(namesByAddress)) {
        map[wallet] = { name };
      }
      return { profilesMap: map, meta, format: "wrapper namesByAddress (wallet->string)" };
    }

    // Heuristic: if most keys look like wallets, treat as direct map
    const walletish = keys.filter(isHexWallet).length;
    if (walletish > 0 && walletish >= Math.max(1, Math.floor(keys.length * 0.5))) {
      return { profilesMap: profilesJson, meta: null, format: "direct wallet->profile map" };
    }
  }

  return { profilesMap: null, meta: null, format: "unknown" };
}

function extractRanges(rangesJson) {
  // format A: direct map tournamentId -> rangeObject
  if (isPlainObject(rangesJson)) {
    // format B: wrapper with rangesByTournamentId
    if (isPlainObject(rangesJson.rangesByTournamentId)) {
      const { rangesByTournamentId, ...meta } = rangesJson;
      return { rangesMap: rangesByTournamentId, meta, format: "wrapper rangesByTournamentId" };
    }

    // Heuristic: if keys are mostly numeric-ish tournament IDs
    const keys = Object.keys(rangesJson);
    const numericish = keys.filter((k) => /^\d+$/.test(k)).length;
    if (numericish > 0 && numericish >= Math.max(1, Math.floor(keys.length * 0.5))) {
      return { rangesMap: rangesJson, meta: null, format: "direct tournamentId->range map" };
    }
  }

  return { rangesMap: null, meta: null, format: "unknown" };
}

function finish(issues, warnings, info = []) {
  console.log("======================================");
  console.log("DFK Leaderboard Data Validation Report");
  console.log("======================================\n");

  if (info.length) {
    console.log("ℹ️ INFO:");
    for (const s of info) console.log(`- ${s}`);
    console.log("");
  }

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

  process.exit(issues.length ? 1 : 0);
}

function main() {
  const issues = [];
  const warnings = [];
  const info = [];

  // Ensure required files exist
  for (const fp of Object.values(FILES)) {
    if (!fs.existsSync(fp)) issues.push(`Missing required file: ${fp}`);
  }
  if (issues.length) return finish(issues, warnings, info);

  // Load JSON
  let leaderboardRaw, profilesRaw, rangesRaw;
  try {
    leaderboardRaw = readJson(FILES.leaderboard);
    profilesRaw = readJson(FILES.profiles);
    rangesRaw = readJson(FILES.ranges);
  } catch (e) {
    issues.push(e.message);
    return finish(issues, warnings, info);
  }

  // Extract wins
  const winsExtract = extractWins(leaderboardRaw);
  if (!winsExtract.wins) {
    issues.push(`leaderboard.json must be Win[] or { wins: Win[] }. Found: ${winsExtract.format}`);
    return finish(issues, warnings, info);
  }
  const wins = winsExtract.wins;
  info.push(`leaderboard.json format: ${winsExtract.format} (${wins.length} wins)`);

  // Extract profiles map
  const profilesExtract = extractProfiles(profilesRaw);
  if (!profilesExtract.profilesMap) {
    issues.push(
      `profiles.json must be a wallet->profile map OR { namesByAddress: {wallet->name} }. Found: ${profilesExtract.format}`
    );
    return finish(issues, warnings, info);
  }
  const profilesMap = profilesExtract.profilesMap;
  info.push(`profiles.json format: ${profilesExtract.format} (${Object.keys(profilesMap).length} entries)`);

  // Extract ranges map
  const rangesExtract = extractRanges(rangesRaw);
  if (!rangesExtract.rangesMap) {
    issues.push(
      `tournamentRanges.json must be tournamentId->range map OR { rangesByTournamentId: {...} }. Found: ${rangesExtract.format}`
    );
    return finish(issues, warnings, info);
  }
  const rangesMap = rangesExtract.rangesMap;
  info.push(`tournamentRanges.json format: ${rangesExtract.format} (${Object.keys(rangesMap).length} entries)`);

  // Validate profiles keys + values
  const badProfileKeys = [];
  let blankNames = 0;

  for (const [walletKey, profile] of Object.entries(profilesMap)) {
    if (!isHexWallet(walletKey)) badProfileKeys.push(walletKey);
    if (walletKey !== walletKey.toLowerCase()) warnings.push(`profiles key not lowercase: ${walletKey}`);

    // profile might be a string if someone changes the file later; handle both
    let name = null;
    if (typeof profile === "string") name = profile;
    else if (isPlainObject(profile) && typeof profile.name === "string") name = profile.name;

    if (!name || !String(name).trim()) blankNames++;
  }

  if (badProfileKeys.length) {
    issues.push(`profiles has invalid wallet keys: ${summarizeList(badProfileKeys).join(", ")}`);
  }
  if (blankNames) warnings.push(`profiles has ${blankNames} entries with blank/invalid name values`);

  // Validate ranges values
  const badRangeValues = [];
  for (const [tid, r] of Object.entries(rangesMap)) {
    if (!isPlainObject(r)) {
      badRangeValues.push(String(tid));
      continue;
    }
    const { minLevel, maxLevel } = r;
    const minOk = typeof minLevel === "number" && Number.isFinite(minLevel);
    const maxOk = typeof maxLevel === "number" && Number.isFinite(maxLevel);
    if (!minOk || !maxOk) {
      badRangeValues.push(String(tid));
      continue;
    }
    if (minLevel > maxLevel || minLevel < 1 || maxLevel > 200) {
      badRangeValues.push(String(tid));
    }
  }
  if (badRangeValues.length) {
    issues.push(`tournamentRanges has invalid range objects for: ${summarizeList(badRangeValues).join(", ")}`);
  }

  // Validate wins + ranges coverage + profile hit rate
  const badWallets = [];
  const badTimestamps = [];
  const badTournamentIds = [];
  const missingRangeTournamentIds = new Set();
  const dupes = [];
  const dedupeKeySet = new Set();

  const now = nowUnix();
  let profileHits = 0;

  for (let i = 0; i < wins.length; i++) {
    const w = wins[i];
    if (!isPlainObject(w)) {
      issues.push(`leaderboard wins item at index ${i} is not an object.`);
      continue;
    }

    const wallet = w.wallet;
    const tournamentId = w.tournamentId;
    const timestamp = w.timestamp;

    if (!isHexWallet(wallet)) badWallets.push(`idx${i}:${String(wallet)}`);

    let ts = timestamp;
    if (typeof ts === "string" && ts.trim() !== "" && /^\d+$/.test(ts)) ts = Number(ts);

    if (typeof ts !== "number" || !isInt(ts) || ts < 1400000000 || ts > now + 3600) {
      badTimestamps.push(`idx${i}:${String(timestamp)}`);
    }

    if (tournamentId === undefined || tournamentId === null || String(tournamentId).trim() === "") {
      badTournamentIds.push(`idx${i}:${String(tournamentId)}`);
    }

    const walletLower = typeof wallet === "string" ? wallet.toLowerCase() : wallet;
    const prof = profilesMap[walletLower];
    let name = null;
    if (typeof prof === "string") name = prof;
    else if (isPlainObject(prof) && typeof prof.name === "string") name = prof.name;
    if (name && String(name).trim()) profileHits++;

    const tid = String(tournamentId);
    if (!rangesMap[tid]) missingRangeTournamentIds.add(tid);

    const dedupeKey = `${walletLower}|${tid}|${String(timestamp)}`;
    if (dedupeKeySet.has(dedupeKey)) dupes.push(dedupeKey);
    dedupeKeySet.add(dedupeKey);
  }

  if (badWallets.length) issues.push(`Invalid wallet(s) in wins: ${summarizeList(badWallets).join(", ")}`);
  if (badTimestamps.length) issues.push(`Invalid timestamp(s) in wins: ${summarizeList(badTimestamps).join(", ")}`);
  if (badTournamentIds.length)
    issues.push(`Missing/invalid tournamentId(s) in wins: ${summarizeList(badTournamentIds).join(", ")}`);

  if (dupes.length) warnings.push(`Possible duplicate wins (wallet|tid|timestamp): ${summarizeList(dupes).join(", ")}`);

  // This is the key "must fix" for correct lvl10/lvl20 counting
  if (missingRangeTournamentIds.size) {
    issues.push(
      `Missing tournamentRanges entries for tournamentId(s): ${summarizeList([...missingRangeTournamentIds]).join(", ")}`
    );
  }

  const hitRate = wins.length ? (profileHits / wins.length) * 100 : 100;
  info.push(`Profile name hit rate: ${profileHits}/${wins.length} (${hitRate.toFixed(1)}%)`);

  finish(issues, warnings, info);
}

main();