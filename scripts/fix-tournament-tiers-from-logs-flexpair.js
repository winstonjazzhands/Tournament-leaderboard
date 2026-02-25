// scripts/fix-tournament-tiers-from-logs-flexpair.js
// ESM (works with "type":"module")
//
// Usage:
//   node scripts/fix-tournament-tiers-from-logs-flexpair.js
//
// What it does:
// - Reads public/leaderboard.json
// - Builds/updates public/tournamentRanges.json by scanning on-chain logs
// - Rewrites each win's `tier` based on maxLevel (10 or 20)
// - Writes leaderboard.json back (and keeps a .bak)
//
// Notes:
// - This is intentionally ABI-light: it uses a "flexpair" heuristic to decode min/max
// - You can tune LOOKBACK_BLOCKS if needed

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- CONFIG ----------
const RPC =
  process.env.METIS_RPC ||
  "https://andromeda.metis.io/?owner=1088";

// TournamentDiamond on Metis (the emitter you were already using for wins)
const TOURNAMENT_DIAMOND =
  (process.env.TOURNAMENT_DIAMOND ||
    "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

// How far back from the earliest seen win block for a tournament to search
const LOOKBACK_BLOCKS = Number(process.env.LOOKBACK_BLOCKS || 1_500_000);

// Chunk size for getLogs
const LOG_CHUNK_BLOCKS = Number(process.env.LOG_CHUNK_BLOCKS || 60_000);

const LEADERBOARD_PATH =
  process.env.LEADERBOARD_PATH ||
  path.join(__dirname, "..", "public", "leaderboard.json");

const RANGES_PATH =
  process.env.RANGES_PATH ||
  path.join(__dirname, "..", "public", "tournamentRanges.json");

// If your wins have no `block`, set this as a fallback start
const FALLBACK_START_BLOCK = Number(process.env.FALLBACK_START_BLOCK || 22_000_000);
// ---------- /CONFIG ----------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function hex32FromDecString(decStr) {
  // tournament IDs are small ints, but stored as uint256 words
  const bn = BigInt(decStr);
  let hex = bn.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return "0x" + hex.padStart(64, "0");
}

function toWords(dataHex) {
  // dataHex: 0x + 64*N
  const hex = (dataHex || "0x").slice(2);
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    words.push("0x" + hex.slice(i, i + 64));
  }
  return words;
}

function asU256(wordHex) {
  try {
    return BigInt(wordHex);
  } catch {
    return null;
  }
}

function isLikelyLevel(x) {
  // DFK hero level ranges are small.
  // Accept 1..100 to be safe; later we prefer max in {10, 20}
  return typeof x === "bigint" && x >= 1n && x <= 100n;
}

function chooseBestFlexPair(words, tidWordIndex) {
  // Look around tournamentId for small ints that could be min/max.
  // Prefer:
  // - max in {10, 20}
  // - min <= max
  // - min not crazy (1..20 usually)
  const WINDOW = 14; // words left/right to inspect
  const start = Math.max(0, tidWordIndex - WINDOW);
  const end = Math.min(words.length - 1, tidWordIndex + WINDOW);

  const candidates = [];
  for (let i = start; i <= end; i++) {
    const v = asU256(words[i]);
    if (isLikelyLevel(v)) candidates.push({ i, v: Number(v) });
  }

  let best = null;

  // Try all ordered pairs in the window
  for (let a = 0; a < candidates.length; a++) {
    for (let b = 0; b < candidates.length; b++) {
      if (a === b) continue;
      const min = candidates[a].v;
      const max = candidates[b].v;
      if (min > max) continue;

      // score
      let score = 0;
      if (max === 20) score += 1000;
      else if (max === 10) score += 800;
      else score += 100;

      // prefer tighter, plausible ranges
      if (min >= 1 && min <= 20) score += 40;
      if (max - min <= 20) score += 10;

      // prefer closer to tournamentId word index
      score += 20 - Math.min(20, Math.abs(candidates[a].i - tidWordIndex));
      score += 20 - Math.min(20, Math.abs(candidates[b].i - tidWordIndex));

      // slight preference that min appears before max
      if (candidates[a].i < candidates[b].i) score += 5;

      if (!best || score > best.score) {
        best = { minLevel: min, maxLevel: max, score };
      }
    }
  }

  return best;
}

function pickTierFromMaxLevel(maxLevel) {
  if (maxLevel >= 16) return 20; // 16-20 is lvl20 tournaments
  return 10;                     // everything else treated as lvl10
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  const leaderboard = readJson(LEADERBOARD_PATH);
  const wins = Array.isArray(leaderboard.wins) ? leaderboard.wins : [];
  console.log(`Loaded wins: ${wins.length}`);

  // Load cache if exists
  let cache = { updatedAtUtc: null, ranges: {} };
  if (fs.existsSync(RANGES_PATH)) {
    try {
      cache = readJson(RANGES_PATH);
      if (!cache.ranges) cache.ranges = {};
    } catch {
      // ignore
    }
  }
  console.log(`Cache entries: ${Object.keys(cache.ranges || {}).length}`);

  // Build tournamentId -> earliestBlock (from wins)
  const perTid = new Map();
  for (const w of wins) {
    const tid = (w.tournamentId ?? w.tourneyId ?? w.id ?? "").toString();
    if (!tid) continue;

    const block = Number(w.block ?? w.blockNumber ?? 0) || 0;
    const cur = perTid.get(tid) || { tid, earliestBlock: null };
    if (block > 0) {
      if (cur.earliestBlock == null || block < cur.earliestBlock) {
        cur.earliestBlock = block;
      }
    }
    perTid.set(tid, cur);
  }

  const uniqueTids = [...perTid.keys()];
  console.log(`Unique tournamentIds: ${uniqueTids.length}`);

  // Determine which need resolving
  const missing = uniqueTids.filter((tid) => !cache.ranges?.[tid]);
  console.log(`Missing tournament ranges: ${missing.length}`);

  // Find latest block once
  const latestBlock = await provider.getBlockNumber();
  console.log(`Latest block: ${latestBlock}`);
  console.log(`Contract: ${TOURNAMENT_DIAMOND}`);
  console.log(`Scanning logs in chunks of ${LOG_CHUNK_BLOCKS} blocks...`);

  // For each missing tournamentId, scan backward from earliestBlock (or fallback)
  for (let idx = 0; idx < missing.length; idx++) {
    const tid = missing[idx];
    const entry = perTid.get(tid);
    const anchor = entry?.earliestBlock ?? FALLBACK_START_BLOCK;
    const from = Math.max(0, anchor - LOOKBACK_BLOCKS);
    const to = Math.min(latestBlock, anchor);

    const tidWord = hex32FromDecString(tid).slice(2).toLowerCase();

    let found = null;

    // scan forward (older->newer) so “first found” tends to be closer to creation/config
    for (let start = from; start <= to; start += LOG_CHUNK_BLOCKS) {
      const end = Math.min(to, start + LOG_CHUNK_BLOCKS - 1);

      let logs = [];
      try {
        logs = await provider.getLogs({
          address: TOURNAMENT_DIAMOND,
          fromBlock: start,
          toBlock: end,
        });
      } catch (e) {
        console.warn(`getLogs failed ${start}..${end}: ${String(e?.message || e)}`);
        continue;
      }

      if (!logs.length) continue;

      for (const log of logs) {
        const data = (log.data || "0x").slice(2).toLowerCase();
        if (!data.includes(tidWord)) continue;

        const words = toWords(log.data);
        // find the first occurrence word index that equals tid
        let hitIndex = -1;
        for (let wi = 0; wi < words.length; wi++) {
          if (words[wi].slice(2).toLowerCase() === tidWord) {
            hitIndex = wi;
            break;
          }
        }
        if (hitIndex < 0) continue;

        const best = chooseBestFlexPair(words, hitIndex);
        if (!best) continue;

        // prefer max=10/20; if something else, keep searching
        const tier = pickTierFromMaxLevel(best.maxLevel);
        found = {
          tournamentId: tid,
          minLevel: best.minLevel,
          maxLevel: best.maxLevel,
          tier,
          source: "logs:flexpair",
          atBlock: Number(log.blockNumber),
          txHash: log.transactionHash,
          logIndex: Number(log.index),
        };

        // If we hit a clean 16-20 or 1-10 style range, stop early.
        if ((found.maxLevel === 20 && found.minLevel >= 10) || found.maxLevel === 10) {
          break;
        }
      }

      if (found) break;
    }

    if (found) {
      cache.ranges[tid] = found;
      if ((idx + 1) % 10 === 0 || idx === missing.length - 1) {
        console.log(`Resolved ${idx + 1}/${missing.length} (latest tid=${tid} => ${found.minLevel}-${found.maxLevel} tier=${found.tier})`);
      }
    } else {
      cache.ranges[tid] = {
        tournamentId: tid,
        minLevel: null,
        maxLevel: null,
        tier: null,
        source: "logs:flexpair:unresolved",
      };
      console.log(`Unresolved tid=${tid} (kept placeholder)`);
    }
  }

  // Write ranges cache
  cache.updatedAtUtc = new Date().toISOString();
  writeJson(RANGES_PATH, cache);
  console.log(`Wrote ${RANGES_PATH}`);

  // Rewrite wins tiers
  let fixed = 0;
  let unknown = 0;

  for (const w of wins) {
    const tid = (w.tournamentId ?? w.tourneyId ?? w.id ?? "").toString();
    if (!tid) continue;

    const r = cache.ranges?.[tid];
    const newTier = r?.tier === 10 || r?.tier === 20 ? r.tier : null;

    if (newTier == null) {
      unknown++;
      continue;
    }

    if (w.tier !== newTier) {
      w.tier = newTier;
      fixed++;
    }
  }

  // Backup + write leaderboard
  const bak = LEADERBOARD_PATH.replace(/\.json$/i, "") + `.bak.${Date.now()}.json`;
  fs.copyFileSync(LEADERBOARD_PATH, bak);
  writeJson(LEADERBOARD_PATH, leaderboard);

  console.log(`Rewrote tiers. Updated wins: ${fixed}. Unknown tier wins: ${unknown}.`);
  console.log(`Backup written: ${bak}`);
  console.log(`Done.`);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});