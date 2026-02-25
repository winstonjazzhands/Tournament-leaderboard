/**
 * Sample70 reset script (post-22M): pulls tournamentWins from subgraph, filters to block>=START_BLOCK,
 * takes first 70 unique tournamentIds (sorted), then resolves tier by scanning diamond logs in a lookback window.
 *
 * Decoder strategy (more practical than v2-minmax adjacency):
 *  1) Try to find a (min,max) pair NEAR the tournamentId word, where:
 *      - max is 10 or 20
 *      - min <= max
 *      - max-min <= 4
 *      - max is within +SPAN words of min (min/max not necessarily adjacent)
 *      - pair is within +/- WINDOW words of the tournamentId word
 *  2) If that fails, fallback to "nearest 10 or 20" near tournamentId BUT ONLY if it's unambiguous:
 *      - If BOTH 10 and 20 appear in the window, return null (don't guess)
 *
 * Outputs:
 *   - public/leaderboard.sample70.json
 * Cache:
 *   - scripts/.cache/tournament-tier-cache.sample70.json (separate from your main cache)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CFG = {
  SUBGRAPH_ENDPOINT:
    process.env.SUBGRAPH_ENDPOINT ||
    "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7",

  RPC: process.env.RPC || "https://andromeda.metis.io/?owner=1088",

  TOURNAMENT_DIAMOND:
    process.env.TOURNAMENT_DIAMOND ||
    "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B",

  START_BLOCK: Number(process.env.START_BLOCK || "22000000"),
  LOOKBACK_BLOCKS: Number(process.env.LOOKBACK_BLOCKS || "1500000"),
  LOG_CHUNK_BLOCKS: Number(process.env.LOG_CHUNK_BLOCKS || "60000"),

  SAMPLE_TOURNAMENTS: Number(process.env.SAMPLE_TOURNAMENTS || "70"),

  THROTTLE_MS: Number(process.env.THROTTLE_MS || "0"),

  OUT_JSON: path.resolve(__dirname, "..", "public", "leaderboard.sample70.json"),

  CACHE_DIR: path.resolve(__dirname, ".cache"),
  CACHE_FILE: path.resolve(__dirname, ".cache", "tournament-tier-cache.sample70.json"),
};

const DECODE_VERSION = "sample70-v1-flexpair";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJsonPretty(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function toLower0x(addr) {
  return (addr || "").toLowerCase();
}
function hex32FromU256(n) {
  const bi = BigInt(n);
  return ethers.zeroPadValue(ethers.toBeHex(bi), 32).toLowerCase();
}
function splitDataWords(dataHex) {
  if (!dataHex || dataHex === "0x") return [];
  const clean = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const out = [];
  for (let i = 0; i + 64 <= clean.length; i += 64) {
    out.push(("0x" + clean.slice(i, i + 64)).toLowerCase());
  }
  return out;
}
function extractWordsFromLog(log) {
  const topics = (log.topics || []).map((t) => (t || "").toLowerCase());
  const dataWords = splitDataWords(log.data);
  return [...topics, ...dataWords];
}
function wordToSmallInt(hexWord) {
  try {
    const bi = BigInt(hexWord);
    if (bi < 0n || bi > 10_000n) return null;
    return Number(bi);
  } catch {
    return null;
  }
}

function loadCache() {
  const raw = readJsonSafe(CFG.CACHE_FILE, null);
  if (raw && typeof raw === "object" && raw.byTournamentId && typeof raw.byTournamentId === "object") {
    return raw;
  }
  return { byTournamentId: {} };
}

/**
 * Flexible min/max pair decoder:
 * - Look for tournamentId word occurrences.
 * - In +/- WINDOW around it, collect candidate ints in [0..30] (min candidates),
 *   and look ahead up to SPAN for max in {10,20}.
 * - Validate min<=max and max-min<=4.
 * - Choose best by proximity to tidIdx and tightness.
 */
function inferTierFlexPair(words, tidWord) {
  const tidIdxs = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === tidWord) tidIdxs.push(i);
  }
  if (!tidIdxs.length) return null;

  const WINDOW = 40; // how far from tid to look
  const SPAN = 14;   // how far apart min and max can be
  const MAX_DRIFT = 4;

  let best = null; // {tier, score, min, max, minIdx, maxIdx, tidIdx}

  for (const tidIdx of tidIdxs) {
    const start = Math.max(0, tidIdx - WINDOW);
    const end = Math.min(words.length - 1, tidIdx + WINDOW);

    // Collect indices with small ints likely to be min-level (0..30 is safe enough for hero levels)
    const ints = [];
    for (let i = start; i <= end; i++) {
      const v = wordToSmallInt(words[i]);
      if (v == null) continue;
      if (v < 0 || v > 30) continue;
      ints.push({ idx: i, v });
    }

    // Find min->max pair, max must be 10 or 20 within +SPAN
    for (const a of ints) {
      const min = a.v;
      for (let j = a.idx + 1; j <= Math.min(end, a.idx + SPAN); j++) {
        const max = wordToSmallInt(words[j]);
        if (max !== 10 && max !== 20) continue;

        if (min > max) continue;
        if (max - min > MAX_DRIFT) continue;

        // Score:
        //  - closer to tidIdx is better
        //  - exact 10-10 or 20-20 gets a bump
        //  - shorter min->max distance gets a tiny bump
        const distToTid = Math.min(Math.abs(a.idx - tidIdx), Math.abs(j - tidIdx));
        const exactBonus = (min === max) ? 25 : 0;
        const spanBonus = (SPAN - (j - a.idx)); // prefer tighter pairs
        const score = 10_000 - distToTid * 80 + exactBonus + spanBonus;

        if (!best || score > best.score) {
          best = { tier: max, score, min, max, minIdx: a.idx, maxIdx: j, tidIdx };
        }
      }
    }
  }

  return best ? best.tier : null;
}

/**
 * Fallback: nearest 10/20 word near tid, ONLY if unambiguous.
 */
function inferTierNearestUnambiguous(words, tidWord) {
  const tidIdxs = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === tidWord) tidIdxs.push(i);
  }
  if (!tidIdxs.length) return null;

  const WINDOW = 40;

  for (const tidIdx of tidIdxs) {
    const start = Math.max(0, tidIdx - WINDOW);
    const end = Math.min(words.length - 1, tidIdx + WINDOW);

    let seen10 = false;
    let seen20 = false;

    for (let i = start; i <= end; i++) {
      const v = wordToSmallInt(words[i]);
      if (v === 10) seen10 = true;
      if (v === 20) seen20 = true;
    }

    if (seen10 && seen20) {
      // ambiguous: don't guess
      continue;
    }

    const target = seen10 ? 10 : (seen20 ? 20 : null);
    if (!target) continue;

    // Find nearest occurrence to tidIdx
    let bestDist = Infinity;
    for (let i = start; i <= end; i++) {
      const v = wordToSmallInt(words[i]);
      if (v !== target) continue;
      const d = Math.abs(i - tidIdx);
      if (d < bestDist) bestDist = d;
    }

    if (bestDist < Infinity) return target;
  }

  return null;
}

async function findTierByLookback({ provider, diamond, tournamentId, winBlock }) {
  const tidWord = hex32FromU256(tournamentId);
  const start = Math.max(0, Number(winBlock) - Number(CFG.LOOKBACK_BLOCKS));
  const end = Number(winBlock);

  for (let toBlock = end; toBlock >= start; toBlock -= CFG.LOG_CHUNK_BLOCKS) {
    const fromBlock = Math.max(start, toBlock - CFG.LOG_CHUNK_BLOCKS + 1);

    let logs = [];
    try {
      logs = await provider.getLogs({ address: diamond, fromBlock, toBlock });
    } catch (e) {
      return { tier: null, matchedBlock: null, error: String(e?.message || e) };
    }

    // newest first
    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      const words = extractWordsFromLog(log);
      if (!words.includes(tidWord)) continue;

      let tier = inferTierFlexPair(words, tidWord);
      if (tier !== 10 && tier !== 20) {
        tier = inferTierNearestUnambiguous(words, tidWord);
      }

      if (tier === 10 || tier === 20) {
        return { tier, matchedBlock: Number(log.blockNumber) };
      }
    }

    if (CFG.THROTTLE_MS > 0) await sleep(CFG.THROTTLE_MS);
  }

  return { tier: null, matchedBlock: null };
}

async function gqlFetchAllTournamentWins(endpoint) {
  const all = [];
  const first = 1000;
  let skip = 0;

  const query = `
    query($first: Int!, $skip: Int!) {
      tournamentWins(first: $first, skip: $skip, orderBy: timestamp, orderDirection: asc) {
        id
        timestamp
        tournamentId
        blockNumber
        player { id }
      }
    }
  `;

  while (true) {
    const body = JSON.stringify({ query, variables: { first, skip } });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Subgraph HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const json = await res.json();
    if (json.errors?.length) {
      throw new Error(`Subgraph errors: ${JSON.stringify(json.errors)}`);
    }

    const batch = json?.data?.tournamentWins || [];
    all.push(...batch);

    console.log(`[sample70] page=${skip / first} batch=${batch.length} total=${all.length}`);

    if (batch.length < first) break;
    skip += first;
  }

  return all;
}

function aggregateLeaderboardFromWins(wins) {
  const by = new Map();

  for (const w of wins) {
    const wallet = toLower0x(w.wallet);
    if (!wallet) continue;

    const cur =
      by.get(wallet) || {
        wallet,
        lvl10Wins: 0,
        lvl20Wins: 0,
        totalWins: 0,
        lastWin: 0,
      };

    if (w.tier === 10) cur.lvl10Wins++;
    else if (w.tier === 20) cur.lvl20Wins++;

    cur.totalWins++;
    if (Number(w.timestamp) > cur.lastWin) cur.lastWin = Number(w.timestamp);

    by.set(wallet, cur);
  }

  return [...by.values()]
    .sort((a, b) => (b.totalWins - a.totalWins) || (b.lastWin - a.lastWin) || a.wallet.localeCompare(b.wallet))
    .map((r, i) => ({
      rank: i + 1,
      wallet: r.wallet,
      lvl10Wins: r.lvl10Wins,
      lvl20Wins: r.lvl20Wins,
      totalWins: r.totalWins,
      lastWin: r.lastWin,
    }));
}

async function main() {
  console.log(`[sample70] subgraph: ${CFG.SUBGRAPH_ENDPOINT}`);
  console.log(`[sample70] rpc: ${CFG.RPC}`);
  console.log(`[sample70] diamond: ${CFG.TOURNAMENT_DIAMOND}`);
  console.log(`[sample70] startBlock: ${CFG.START_BLOCK}`);
  console.log(`[sample70] lookbackBlocks: ${CFG.LOOKBACK_BLOCKS}`);
  console.log(`[sample70] logChunkBlocks: ${CFG.LOG_CHUNK_BLOCKS}`);
  console.log(`[sample70] sample tournaments: ${CFG.SAMPLE_TOURNAMENTS}`);
  console.log(`[sample70] decodeVersion: ${DECODE_VERSION}`);

  ensureDir(CFG.CACHE_DIR);
  const cache = loadCache();
  if (!cache.byTournamentId) cache.byTournamentId = {};

  const provider = new ethers.JsonRpcProvider(CFG.RPC);
  const diamond = ethers.getAddress(CFG.TOURNAMENT_DIAMOND);

  const rawWins = await gqlFetchAllTournamentWins(CFG.SUBGRAPH_ENDPOINT);

  const winsAll = rawWins
    .map((w) => ({
      id: w.id,
      tournamentId: Number(w.tournamentId),
      timestamp: Number(w.timestamp),
      blockNumber: Number(w.blockNumber),
      wallet: toLower0x(w?.player?.id),
    }))
    .filter((w) => w.wallet && Number.isFinite(w.tournamentId) && Number.isFinite(w.timestamp) && Number.isFinite(w.blockNumber))
    .filter((w) => w.blockNumber >= CFG.START_BLOCK);

  // Map tid->first winBlock after startBlock
  const tidToWinBlock = new Map();
  for (const w of winsAll) {
    if (!tidToWinBlock.has(w.tournamentId)) tidToWinBlock.set(w.tournamentId, w.blockNumber);
  }

  const tidsAll = [...tidToWinBlock.keys()].sort((a, b) => a - b);
  const tids = tidsAll.slice(0, CFG.SAMPLE_TOURNAMENTS);

  console.log(`[sample70] wins(post)=${winsAll.length} uniqueTournaments(post)=${tidsAll.length}`);
  console.log(`[sample70] working set tournaments=${tids.length} (first ${CFG.SAMPLE_TOURNAMENTS})`);
  console.log(`[sample70] tournamentIds sample: ${tids.slice(0, 12).join(", ")}${tids.length > 12 ? ", ..." : ""}`);

  // Resolve tiers for tids
  for (let i = 0; i < tids.length; i++) {
    const tid = tids[i];
    const winBlock = tidToWinBlock.get(tid);

    console.log(`[sample70] ${i + 1}/${tids.length} tid=${tid} winBlock=${winBlock}`);

    const found = await findTierByLookback({ provider, diamond, tournamentId: tid, winBlock });

    if (found?.tier === 10 || found?.tier === 20) {
      cache.byTournamentId[String(tid)] = {
        tier: found.tier,
        matchedBlock: found.matchedBlock,
        anchorWinBlock: winBlock,
        method: "logs/lookback",
        resolvedAtUtc: new Date().toISOString(),
        decodeVersion: DECODE_VERSION,
      };
      console.log(`[sample70]  ✅ tier=${found.tier} matchedBlock=${found.matchedBlock}`);
    } else {
      cache.byTournamentId[String(tid)] = {
        tier: null,
        matchedBlock: null,
        anchorWinBlock: winBlock,
        method: "logs/lookback",
        resolvedAtUtc: new Date().toISOString(),
        decodeVersion: DECODE_VERSION,
        error: found?.error || null,
      };
      console.log(`[sample70]  ⚠️  unknown tier`);
    }
  }

  writeJsonPretty(CFG.CACHE_FILE, cache);
  console.log(`[sample70] cache saved: ${CFG.CACHE_FILE}`);

  // Build sample wins output: only wins whose tournamentId is in tids set
  const tidSet = new Set(tids);
  const winsSample = winsAll
    .filter((w) => tidSet.has(w.tournamentId))
    .map((w) => {
      const entry = cache.byTournamentId[String(w.tournamentId)];
      const tier = entry?.tier === 10 || entry?.tier === 20 ? entry.tier : null;
      return {
        id: w.id,
        tournamentId: w.tournamentId,
        wallet: w.wallet,
        timestamp: w.timestamp,
        blockNumber: w.blockNumber,
        tier,
      };
    });

  const unknownTierWins = winsSample.filter((w) => !w.tier).length;
  const uniqueTournaments = tids.length;

  const leaderboard = aggregateLeaderboardFromWins(winsSample);

  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "subgraph+logs/lookback(sample70)",
    decodeVersion: DECODE_VERSION,
    rpc: CFG.RPC,
    tournamentDiamond: CFG.TOURNAMENT_DIAMOND,
    startBlock: CFG.START_BLOCK,
    lookbackBlocks: CFG.LOOKBACK_BLOCKS,
    logChunkBlocks: CFG.LOG_CHUNK_BLOCKS,
    sampleTournaments: CFG.SAMPLE_TOURNAMENTS,
    totalWins: winsSample.length,
    uniqueTournaments,
    unknownTierWins,
    wins: winsSample,
    leaderboard,
  };

  ensureDir(path.dirname(CFG.OUT_JSON));
  writeJsonPretty(CFG.OUT_JSON, out);

  const unknownTids = tids.filter((t) => {
    const e = cache.byTournamentId[String(t)];
    return !(e?.tier === 10 || e?.tier === 20);
  });

  console.log(`[sample70] wrote ${CFG.OUT_JSON}`);
  console.log(`[sample70] unknownTierWins: ${unknownTierWins}`);
  console.log(`[sample70] unknown tournamentIds (${unknownTids.length}/${tids.length}): ${unknownTids.join(", ")}`);
}

main().catch((e) => {
  console.error(`[sample70] fatal:`, e);
  process.exitCode = 1;
});