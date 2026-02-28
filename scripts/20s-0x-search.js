#!/usr/bin/env node

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function toMs(ts) {
  if (!ts) return 0;
  return ts > 1e12 ? ts : ts * 1000;
}

function isoUtc(ms) {
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

function startOfUtcWeekMs(nowMs) {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0=Sun,1=Mon
  const daysSinceMonday = (day + 6) % 7;
  d.setUTCDate(d.getUTCDate() - daysSinceMonday);
  d.setUTCHours(0, 0, 0, 0);
  return d.getTime();
}

const walletArg = process.argv.find((a) => a?.startsWith("0x"));
const useRoot = process.argv.includes("--root");

if (!walletArg) {
  console.error("Usage: node scripts/20s-0x-search.js 0xWALLET [--root]");
  process.exit(1);
}
const wallet = walletArg.toLowerCase();

const leaderboardPath = useRoot
  ? path.resolve(process.cwd(), "leaderboard.json")
  : path.resolve(__dirname, "../public/leaderboard.json");

if (!fs.existsSync(leaderboardPath)) {
  console.error("Missing:", leaderboardPath);
  process.exit(1);
}

const wrapped = readJson(leaderboardPath);
const wins = Array.isArray(wrapped.wins) ? wrapped.wins : null;

if (!wins) {
  console.error("leaderboard.json has no wins[] array. Keys:", Object.keys(wrapped));
  process.exit(1);
}

const rows = wins
  .filter((x) => (x.wallet || "").toLowerCase() === wallet)
  .map((x) => ({
    ...x,
    _tsMs: toMs(x.timestamp),
    _tsIso: isoUtc(toMs(x.timestamp)),
    _tierNum: x.tier === undefined || x.tier === null ? null : Number(x.tier),
  }))
  .sort((a, b) => (a._tsMs || 0) - (b._tsMs || 0));

console.log("using:", leaderboardPath);
console.log("wallet:", wallet);
console.log("total wins for wallet:", rows.length);

console.log("\n--- LAST 20 WINS (oldest -> newest) ---");
for (const r of rows.slice(-20)) {
  console.log(`${r._tsIso}  tier=${r.tier ?? "?"}  tournamentId=${r.tournamentId ?? "?"}`);
}

const weekStartMs = startOfUtcWeekMs(Date.now());
console.log("\nUTC week start:", isoUtc(weekStartMs));

const thisWeek = rows.filter((r) => (r._tsMs || 0) >= weekStartMs);

console.log("\n--- THIS WEEK WINS (UTC) ---");
if (thisWeek.length === 0) {
  console.log("No wins this week for this wallet.");
} else {
  for (const r of thisWeek) {
    console.log(`${r._tsIso}  tier=${r.tier ?? "?"}  tournamentId=${r.tournamentId ?? "?"}`);
  }
}

const weekTier20 = thisWeek.filter((r) => r._tierNum === 20);
const weekUnknownTier = thisWeek.filter((r) => r._tierNum === null || Number.isNaN(r._tierNum));

console.log("\nTHIS WEEK tier=20 count:", weekTier20.length);
console.log("THIS WEEK unknown-tier count:", weekUnknownTier.length);
console.log("\nupdatedAtUtc:", wrapped.updatedAtUtc);
console.log("tiersUpdatedAtUtc:", wrapped.tiersUpdatedAtUtc);