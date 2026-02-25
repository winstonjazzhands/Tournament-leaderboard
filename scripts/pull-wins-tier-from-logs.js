/**
 * scripts/pull-wins-tier-from-logs.js
 *
 * Plan:
 * 1) Pull wins from subgraph with tournamentId + timestamp + blockNumber + player
 * 2) For each tournamentId, search logs near the win block for data containing tournamentId (as 32-byte word)
 * 3) From matching logs, scan 32-byte words and pick the first clear tier signal (10 or 20)
 * 4) Cache tournamentId->tier so future runs are fast
 * 5) Write public/leaderboard.json with wins[] + leaderboard[] split into lvl10/lvl20
 *
 * Run:
 *   node scripts/pull-wins-tier-from-logs.js
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const OUT_FILE = path.join(process.cwd(), "public", "leaderboard.json");
const CACHE_DIR = path.join(process.cwd(), "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "tournament-tier-from-logs-cache.json");

// Subgraph pagination
const PAGE_SIZE = 1000;
const MAX_PAGES = 8000;

// Log scan tuning
const LOOKBACK_BLOCKS = 150000;     // how far back from win block to scan
const CHUNK_SIZE = 2000;            // getLogs chunk size
const MAX_LOG_MATCHES_PER_TOURNAMENT = 25; // stop early if too many hits

function nowUtcIso() {
  return new Date().toISOString();
}

async function gql(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json?.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function toInt(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeWallet(player) {
  if (!player) return null;
  if (typeof player === "string") return player.toLowerCase();
  if (typeof player === "object" && typeof player.id === "string") return player.id.toLowerCase();
  return null;
}

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

// 32-byte encoded tournamentId (uint256)
function tournamentIdWordHex(tournamentId) {
  // returns hex string WITHOUT 0x, 64 chars
  const w = ethers.zeroPadValue(ethers.toBeHex(BigInt(tournamentId)), 32);
  return w.slice(2).toLowerCase();
}

function splitDataWords(logDataHex) {
  const hex = (logDataHex || "0x").replace(/^0x/, "");
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) {
    words.push("0x" + hex.slice(i, i + 64));
  }
  return words;
}

function wordToSafeNumber(wordHex) {
  try {
    const bi = BigInt(wordHex);
    if (bi > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(bi);
  } catch {
    return null;
  }
}

function extractTierFromWords(words) {
  // We look for an exact 10 or 20 first.
  // If both appear, we try to infer which is the cap by heuristics:
  // - if we see "... min, max ..." where max is 10 or 20, prefer the larger of adjacent small numbers.
  const nums = words.map(wordToSafeNumber);

  const hits = [];
  for (let i = 0; i < nums.length; i++) {
    const v = nums[i];
    if (v === 10 || v === 20) hits.push({ i, v });
  }
  if (!hits.length) return null;

  // If we see only one, take it.
  if (hits.length === 1) return hits[0].v;

  // If we see both 10 and 20, try to decide:
  // Prefer a 10/20 that sits next to another small number (0..25) (likely min/max pair)
  for (const h of hits) {
    for (let j = Math.max(0, h.i - 1); j <= Math.min(nums.length - 1, h.i + 1); j++) {
      const n = nums[j];
      if (n !== null && n >= 0 && n <= 25 && j !== h.i) {
        return h.v;
      }
    }
  }

  // Otherwise just prefer 20 (cap tends to be higher)
  return hits.some(h => h.v === 20) ? 20 : 10;
}

async function scanLogsForTournamentTier(provider, tournamentId, winBlock) {
  const tidWord = tournamentIdWordHex(tournamentId);

  const fromBlock = Math.max(0, winBlock - LOOKBACK_BLOCKS);
  const toBlock = winBlock;

  let matchesFound = 0;

  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(toBlock, start + CHUNK_SIZE - 1);

    let logs = [];
    try {
      logs = await provider.getLogs({
        address: DIAMOND,
        fromBlock: start,
        toBlock: end,
      });
    } catch {
      // If provider is picky about range, shrink
      if (CHUNK_SIZE > 200) {
        // fall back to smaller chunk by stepping slower next time
      }
      continue;
    }

    for (const log of logs) {
      const dataHex = (log.data || "0x").toLowerCase().replace(/^0x/, "");
      if (!dataHex || dataHex === "") continue;

      // Require tournamentId word to appear in data (fast substring check)
      if (!dataHex.includes(tidWord)) continue;

      matchesFound++;
      const words = splitDataWords("0x" + dataHex);
      const tier = extractTierFromWords(words);
      if (tier === 10 || tier === 20) {
        return { tier, matchedBlock: log.blockNumber, txHash: log.transactionHash };
      }

      if (matchesFound >= MAX_LOG_MATCHES_PER_TOURNAMENT) {
        // Too many matches without a clear tier; stop to avoid wasting time
        return null;
      }
    }
  }

  return null;
}

async function main() {
  console.log("[tier-logs] subgraph:", SUBGRAPH_URL);
  console.log("[tier-logs] rpc:", RPC_URL);
  console.log("[tier-logs] diamond:", DIAMOND);

  // 1) pull wins (include blockNumber!)
  const winsRaw = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;
    const query = `
      query PullWins($first: Int!, $skip: Int!) {
        tournamentWins(first: $first, skip: $skip, orderBy: timestamp, orderDirection: asc) {
          id
          timestamp
          tournamentId
          blockNumber
          player { id }
        }
      }
    `;
    const data = await gql(query, { first: PAGE_SIZE, skip });
    const batch = data?.tournamentWins || [];
    winsRaw.push(...batch);
    console.log(`[tier-logs] page=${page} batch=${batch.length} total=${winsRaw.length}`);
    if (batch.length < PAGE_SIZE) break;
  }

  const wins = winsRaw
    .map((w) => ({
      id: w.id != null ? String(w.id) : null,
      wallet: normalizeWallet(w.player),
      timestamp: toInt(w.timestamp),
      tournamentId: w.tournamentId != null ? String(w.tournamentId) : null,
      blockNumber: toInt(w.blockNumber),
      tier: null,
    }))
    .filter((w) => w.wallet && w.timestamp && w.tournamentId && w.blockNumber);

  console.log(`[tier-logs] normalized wins=${wins.length}`);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // 2) cache
  const cache = loadCache(); // { [tournamentId]: { tier, matchedBlock, txHash, updatedAtUtc } }
  const tournamentIds = [...new Set(wins.map((w) => w.tournamentId))];

  const missing = tournamentIds.filter((tid) => !cache[tid] || (cache[tid].tier !== 10 && cache[tid].tier !== 20));
  console.log(`[tier-logs] unique tournaments=${tournamentIds.length} missing tiers=${missing.length}`);

  // Map tournamentId -> a representative win blockNumber (use the max win block for that tid)
  const tidToWinBlock = new Map();
  for (const w of wins) {
    const prev = tidToWinBlock.get(w.tournamentId) || 0;
    if (w.blockNumber > prev) tidToWinBlock.set(w.tournamentId, w.blockNumber);
  }

  // 3) scan missing
  let solved = 0;
  for (let i = 0; i < missing.length; i++) {
    const tid = missing[i];
    const winBlock = tidToWinBlock.get(tid);

    if (!winBlock) continue;

    console.log(`[tier-logs] scan ${i + 1}/${missing.length} tournamentId=${tid} winBlock=${winBlock}`);

    const found = await scanLogsForTournamentTier(provider, Number(tid), winBlock);
    if (found && (found.tier === 10 || found.tier === 20)) {
      cache[tid] = { ...found, updatedAtUtc: nowUtcIso() };
      solved++;
      console.log(`[tier-logs]  ✅ tier=${found.tier} matchedBlock=${found.matchedBlock}`);
      saveCache(cache); // persist as we go
    } else {
      cache[tid] = { tier: null, updatedAtUtc: nowUtcIso() };
      // don't spam writes for misses
      if ((i + 1) % 25 === 0) saveCache(cache);
    }
  }

  saveCache(cache);
  console.log(`[tier-logs] cache saved: ${CACHE_FILE} (new solved=${solved})`);

  // 4) apply tiers
  let unknownTierWins = 0;
  for (const w of wins) {
    const c = cache[w.tournamentId];
    w.tier = c?.tier ?? null;
    if (w.tier !== 10 && w.tier !== 20) unknownTierWins++;
  }

  // 5) aggregate
  const byWallet = new Map();
  for (const w of wins) {
    const cur =
      byWallet.get(w.wallet) || {
        wallet: w.wallet,
        lvl10Wins: 0,
        lvl20Wins: 0,
        unknownWins: 0,
        lastWin: 0,
      };

    if (w.timestamp > cur.lastWin) cur.lastWin = w.timestamp;

    if (w.tier === 10) cur.lvl10Wins++;
    else if (w.tier === 20) cur.lvl20Wins++;
    else cur.unknownWins++;

    byWallet.set(w.wallet, cur);
  }

  const leaderboard = [...byWallet.values()]
    .map((x) => ({ ...x, totalWins: x.lvl10Wins + x.lvl20Wins + x.unknownWins }))
    .sort((a, b) => b.totalWins - a.totalWins || b.lastWin - a.lastWin || a.wallet.localeCompare(b.wallet))
    .map((x, i) => ({
      rank: i + 1,
      wallet: x.wallet,
      lvl10Wins: x.lvl10Wins,
      lvl20Wins: x.lvl20Wins,
      unknownWins: x.unknownWins,
      totalWins: x.totalWins,
      lastWin: x.lastWin,
    }));

  const out = {
    updatedAtUtc: nowUtcIso(),
    source: "graph-studio/1.7 + log-tier-cache",
    rpc: RPC_URL,
    tournamentDiamond: DIAMOND,
    totalWins: wins.length,
    uniqueTournaments: tournamentIds.length,
    unknownTierWins,
    wins,
    leaderboard,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`[tier-logs] wrote ${OUT_FILE}`);
  console.log(`[tier-logs] wins=${wins.length} wallets=${leaderboard.length} unknownTierWins=${unknownTierWins}`);
}

main().catch((e) => {
  console.error("[tier-logs] fatal:", e);
  process.exit(1);
});