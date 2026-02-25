#!/usr/bin/env node
/**
 * Build public/tournamentRanges.json from event logs using two seed tx hashes.
 *
 * Known brackets:
 * - Tier 10 tournaments: (10,10)
 * - Tier 20 tournaments commonly: (16,20)
 * - Some tournaments can be higher brackets (e.g., maxLevel 25) -> still treated as tier 20 for payouts
 *
 * This version:
 * 1) Prefers exact adjacent bracket pairs:
 *    - (16,20), (20,20), (10,10)
 * 2) If no pair found, uses a conservative maxLevel fallback:
 *    - if it sees 25 and 20 in the config data => min=20 max=25 tier=20  (fixes tournamentId 1824)
 *    - else if it sees any maxLevel candidate >= 20 => tier=20
 *    - else if it sees 10 (or two 10s) => tier=10
 *
 * Required env:
 *   RPC_URL
 *   SEED_TX_L10
 *   SEED_TX_L20
 *
 * Windows CMD:
 *   set RPC_URL=https://andromeda.metis.io/?owner=1088
 *   set SEED_TX_L10=0x7c410f9faf35cae21b23d1ff35495237e82d500e5845e96fca361d71a9e78820
 *   set SEED_TX_L20=0x216dfd59fedd6b85bbc9548fdab5339e5f5a6f89b753cc196035b1ec80679edb
 *   node scripts/build-tournamentRanges-subgraph.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const LEADERBOARD_PATH = path.join(PUBLIC, "leaderboard.json");
const OUTPUT_PATH = path.join(PUBLIC, "tournamentRanges.json");

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv();

const RPC_URL = process.env.RPC_URL;
const SEED_TX_L10 = process.env.SEED_TX_L10;
const SEED_TX_L20 = process.env.SEED_TX_L20;

const TOURNAMENT_DIAMOND =
  (process.env.TOURNAMENT_DIAMOND || "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const BLOCK_CHUNK = Number(process.env.BLOCK_CHUNK || 50_000);

if (!RPC_URL) {
  console.error("❌ Missing RPC_URL");
  process.exit(1);
}
if (!SEED_TX_L10) {
  console.error("❌ Missing SEED_TX_L10");
  process.exit(1);
}
if (!SEED_TX_L20) {
  console.error("❌ Missing SEED_TX_L20");
  process.exit(1);
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, "utf8"));
}
function writeJson(fp, obj) {
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2) + "\n", "utf8");
}
function extractWins(lb) {
  if (Array.isArray(lb)) return lb;
  if (lb && typeof lb === "object" && Array.isArray(lb.wins)) return lb.wins;
  throw new Error("leaderboard.json must be Win[] or { wins: Win[] }");
}
function uniq(arr) {
  return [...new Set(arr)];
}

function decodeWords(hexData) {
  const clean = (hexData || "0x").startsWith("0x") ? hexData.slice(2) : hexData;
  if (!clean) return [];
  if (clean.length % 64 !== 0) return null;
  const out = [];
  for (let i = 0; i < clean.length; i += 64) out.push(BigInt("0x" + clean.slice(i, i + 64)));
  return out;
}

function tierFrom(minLevel, maxLevel) {
  return maxLevel >= 20 ? 20 : 10;
}

function getTournamentIdFromLog(log) {
  if (!log.topics || log.topics.length < 2) return null;
  try {
    return BigInt(log.topics[1]).toString();
  } catch {
    return null;
  }
}

function findLastExactPair(words, aWanted, bWanted) {
  let lastIdx = -1;
  for (let i = 0; i < words.length - 1; i++) {
    const a = Number(words[i]);
    const b = Number(words[i + 1]);
    if (a === aWanted && b === bWanted) lastIdx = i;
  }
  return lastIdx;
}

function detectTopic0FromSeed(receipt, wantedPairs) {
  const logs = receipt.logs.filter((l) => (l.address || "").toLowerCase() === TOURNAMENT_DIAMOND);

  for (const log of logs) {
    const topic0 = (log.topics?.[0] || "").toLowerCase();
    if (!topic0) continue;

    const tid = getTournamentIdFromLog(log);
    if (!tid) continue;

    const tidNum = Number(tid);
    if (!Number.isFinite(tidNum) || tidNum < 1 || tidNum > 10_000_000) continue;

    const words = decodeWords(log.data || "0x");
    if (!words || words.length < 2) continue;

    for (const [aWanted, bWanted] of wantedPairs) {
      const idx = findLastExactPair(words, aWanted, bWanted);
      if (idx !== -1) {
        return { topic0, pairIndex: idx, matchedPair: [aWanted, bWanted], tournamentId: tid, wordCount: words.length };
      }
    }
  }
  return null;
}

function extractMaxLevelFallback(words) {
  // Look at "small" values where brackets usually live.
  // We only consider reasonable bracket-ish candidates.
  const vals = words.map((w) => Number(w)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 200);

  // If we see 25 and 20, assume bracket 20-25 (matches your 1824 log)
  if (vals.includes(25) && vals.includes(20)) return { minLevel: 20, maxLevel: 25 };

  // Otherwise if we see 30 and 20, could be 20-30, etc.
  const bracketCandidates = [10, 15, 16, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];
  const present = bracketCandidates.filter((x) => vals.includes(x)).sort((a, b) => a - b);

  if (!present.length) return null;

  const maxLevel = present[present.length - 1];

  if (maxLevel >= 20) {
    // choose a plausible minLevel if present
    if (present.includes(16) && maxLevel === 20) return { minLevel: 16, maxLevel: 20 };
    if (present.includes(20) && maxLevel > 20) return { minLevel: 20, maxLevel };
    return { minLevel: maxLevel, maxLevel };
  }

  // Tier 10 fallback
  if (present.includes(10)) return { minLevel: 10, maxLevel: 10 };

  return null;
}

function extractBracketFromLogData(words, pairIndexHint) {
  if (!words || words.length < 2) return null;

  // Adjacent pair priority
  const PAIRS = [
    [16, 20],
    [20, 20],
    [10, 10],
  ];

  // 1) hinted index
  if (Number.isFinite(pairIndexHint) && pairIndexHint >= 0 && pairIndexHint < words.length - 1) {
    const a = Number(words[pairIndexHint]);
    const b = Number(words[pairIndexHint + 1]);
    for (const [x, y] of PAIRS) {
      if (a === x && b === y) return { minLevel: a, maxLevel: b };
    }
  }

  // 2) last adjacent occurrence
  let best = null;
  for (const [x, y] of PAIRS) {
    const idx = findLastExactPair(words, x, y);
    if (idx === -1) continue;
    if (!best || idx > best.idx) best = { idx, minLevel: x, maxLevel: y };
  }
  if (best) return { minLevel: best.minLevel, maxLevel: best.maxLevel };

  // 3) maxLevel fallback (handles 1824 and similar)
  return extractMaxLevelFallback(words);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const net = await provider.getNetwork();
  console.log(`Connected. chainId=${net.chainId.toString()}`);

  const wins = extractWins(readJson(LEADERBOARD_PATH));
  const tournamentIdsNeeded = uniq(
    wins.map((w) => (w && w.tournamentId != null ? String(w.tournamentId) : null)).filter(Boolean)
  ).sort((a, b) => Number(a) - Number(b));

  const neededSet = new Set(tournamentIdsNeeded);

  console.log(`Need tournament ranges for ${tournamentIdsNeeded.length} tournamentIds (from leaderboard.json).`);
  console.log(`Using TOURNAMENT_DIAMOND: ${TOURNAMENT_DIAMOND}`);

  const r10 = await provider.getTransactionReceipt(SEED_TX_L10);
  const r20 = await provider.getTransactionReceipt(SEED_TX_L20);
  if (!r10) throw new Error("Could not fetch receipt for SEED_TX_L10");
  if (!r20) throw new Error("Could not fetch receipt for SEED_TX_L20");

  console.log(`Seed L10 block: ${r10.blockNumber}`);
  console.log(`Seed L20 block: ${r20.blockNumber}`);

  const det10 = detectTopic0FromSeed(r10, [[10, 10]]);
  const det20 = detectTopic0FromSeed(r20, [[16, 20], [20, 20]]);

  if (!det10) throw new Error("Could not detect L10 event (10,10).");
  if (!det20) throw new Error("Could not detect L20 event (16,20 or 20,20).");

  console.log("Detected L10 event:", det10);
  console.log("Detected L20 event:", det20);

  const topicsToScan = uniq([det10.topic0, det20.topic0]).map((t) => t.toLowerCase());
  console.log("Topic0(s) to scan:", topicsToScan.join(", "));

  const latestBlock = await provider.getBlockNumber();
  const startBlockEnv = process.env.START_BLOCK ? Number(process.env.START_BLOCK) : null;
  const endBlockEnv = process.env.END_BLOCK ? Number(process.env.END_BLOCK) : null;

  const endBlock = Number.isFinite(endBlockEnv) ? endBlockEnv : latestBlock;
  const startBlock = Number.isFinite(startBlockEnv) ? startBlockEnv : 0;

  console.log(`Scanning logs from block ${startBlock} to ${endBlock} in chunks of ${BLOCK_CHUNK}...`);

  const rangesByTournamentId = {};
  const missing = new Set(tournamentIdsNeeded);

  const totalChunks = Math.ceil((endBlock - startBlock + 1) / BLOCK_CHUNK);
  let chunkIndex = 0;

  for (let from = startBlock; from <= endBlock; from += BLOCK_CHUNK) {
    const to = Math.min(endBlock, from + BLOCK_CHUNK - 1);
    chunkIndex++;

    console.log(`Chunk ${chunkIndex}/${totalChunks}: blocks ${from}-${to} (missing ${missing.size})`);

    for (const topic0 of topicsToScan) {
      let logs = [];
      try {
        logs = await provider.getLogs({
          address: TOURNAMENT_DIAMOND,
          fromBlock: from,
          toBlock: to,
          topics: [topic0],
        });
      } catch (e) {
        console.log(`⚠️ getLogs failed for topic0 ${topic0} blocks ${from}-${to}: ${e?.message || String(e)}`);
        continue;
      }

      for (const log of logs) {
        const tid = getTournamentIdFromLog(log);
        if (!tid) continue;
        if (!missing.has(tid)) continue;
        if (!neededSet.has(tid)) continue;

        const words = decodeWords(log.data || "0x");
        if (!words) continue;

        const hint =
          topic0 === det10.topic0 ? det10.pairIndex :
          topic0 === det20.topic0 ? det20.pairIndex :
          null;

        const bracket = extractBracketFromLogData(words, hint);
        if (!bracket) continue;

        const tier = tierFrom(bracket.minLevel, bracket.maxLevel);
        rangesByTournamentId[tid] = { ...bracket, tier };
        missing.delete(tid);

        if (missing.size === 0) break;
      }

      if (missing.size === 0) break;
    }

    if (missing.size === 0) break;
  }

  console.log(`Built ranges for ${Object.keys(rangesByTournamentId).length}/${tournamentIdsNeeded.length} tournamentIds.`);

  const counts = { 10: 0, 20: 0 };
  for (const r of Object.values(rangesByTournamentId)) counts[r.tier] = (counts[r.tier] || 0) + 1;
  console.log("Tier counts:", counts);

  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "event-logs-two-seeds-with-maxLevel-fallback",
    rpcUrl: RPC_URL,
    tournamentDiamond: TOURNAMENT_DIAMOND,
    seeds: { level10: SEED_TX_L10, level20: SEED_TX_L20 },
    discovered: { level10: det10, level20: det20, topicsToScan },
    scan: { startBlock, endBlock, blockChunk: BLOCK_CHUNK },
    rangesByTournamentId,
    missingTournamentIds: [...missing],
  };

  writeJson(OUTPUT_PATH, out);
  console.log(`Wrote ${OUTPUT_PATH}`);

  if (missing.size) {
    console.log(`⚠️ Still missing ${missing.size} tournamentIds (first 25): ${[...missing].slice(0, 25).join(", ")}`);
  }
}

main().catch((e) => {
  console.error("ERROR:", e?.message || String(e));
  process.exit(1);
});