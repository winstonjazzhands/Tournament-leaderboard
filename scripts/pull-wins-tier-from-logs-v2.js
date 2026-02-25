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

const PAGE_SIZE = 1000;
const MAX_PAGES = 8000;

const LOOKBACK_FAST = 150000;
const LOOKBACK_SLOW = 600000;
const CHUNK_SIZE = 2000;

function nowUtcIso() { return new Date().toISOString(); }

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
    if (fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
  } catch {}
  return {};
}
function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function tidWordHex(tournamentId) {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(tournamentId)), 32).slice(2).toLowerCase();
}

function splitWords(dataHex) {
  const hex = (dataHex || "0x").replace(/^0x/, "");
  const words = [];
  for (let i = 0; i + 64 <= hex.length; i += 64) words.push("0x" + hex.slice(i, i + 64));
  return words;
}

function wordToSafeNumber(wordHex) {
  try {
    const bi = BigInt(wordHex);
    if (bi > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(bi);
  } catch { return null; }
}

function extractTierFromWords(words) {
  const nums = words.map(wordToSafeNumber);
  const hits = [];
  for (let i = 0; i < nums.length; i++) {
    const v = nums[i];
    if (v === 10 || v === 20) hits.push({ i, v });
  }
  if (!hits.length) return null;
  if (hits.length === 1) return hits[0].v;

  // prefer a hit adjacent to another small number (min/max pattern)
  for (const h of hits) {
    for (let j = Math.max(0, h.i - 1); j <= Math.min(nums.length - 1, h.i + 1); j++) {
      const n = nums[j];
      if (j !== h.i && n !== null && n >= 0 && n <= 25) return h.v;
    }
  }
  return hits.some(h => h.v === 20) ? 20 : 10;
}

function logMentionsTournamentId(log, tidWord) {
  // Check topics (indexed params)
  if (Array.isArray(log.topics)) {
    for (const t of log.topics) {
      if (typeof t === "string" && t.toLowerCase().includes(tidWord)) return true;
    }
  }
  // Check data (non-indexed params)
  const dataHex = (log.data || "").toLowerCase().replace(/^0x/, "");
  if (dataHex && dataHex.includes(tidWord)) return true;

  return false;
}

async function scan(provider, tournamentId, winBlock, lookback) {
  const tidWord = tidWordHex(tournamentId);
  const fromBlock = Math.max(0, winBlock - lookback);
  const toBlock = winBlock;

  for (let start = fromBlock; start <= toBlock; start += CHUNK_SIZE) {
    const end = Math.min(toBlock, start + CHUNK_SIZE - 1);

    let logs = [];
    try {
      logs = await provider.getLogs({ address: DIAMOND, fromBlock: start, toBlock: end });
    } catch {
      continue;
    }

    for (const log of logs) {
      if (!logMentionsTournamentId(log, tidWord)) continue;

      const words = splitWords(log.data || "0x");
      const tier = extractTierFromWords(words);
      if (tier === 10 || tier === 20) {
        return { tier, matchedBlock: log.blockNumber, txHash: log.transactionHash };
      }
    }
  }

  return null;
}

async function main() {
  console.log("[tier-logs-v2] subgraph:", SUBGRAPH_URL);

  const winsRaw = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;
    const data = await gql(
      `query PullWins($first:Int!,$skip:Int!){
        tournamentWins(first:$first,skip:$skip,orderBy:timestamp,orderDirection:asc){
          id timestamp tournamentId blockNumber player{ id }
        }
      }`,
      { first: PAGE_SIZE, skip }
    );
    const batch = data?.tournamentWins || [];
    winsRaw.push(...batch);
    console.log(`[tier-logs-v2] page=${page} batch=${batch.length} total=${winsRaw.length}`);
    if (batch.length < PAGE_SIZE) break;
  }

  const wins = winsRaw
    .map((w) => ({
      id: String(w.id),
      wallet: normalizeWallet(w.player),
      timestamp: toInt(w.timestamp),
      tournamentId: String(w.tournamentId),
      blockNumber: toInt(w.blockNumber),
      tier: null,
    }))
    .filter((w) => w.wallet && w.timestamp && w.tournamentId && w.blockNumber);

  const provider = new ethers.JsonRpcProvider(RPC_URL);

  const cache = loadCache();
  const tids = [...new Set(wins.map((w) => w.tournamentId))];

  const tidToWinBlock = new Map();
  for (const w of wins) {
    const prev = tidToWinBlock.get(w.tournamentId) || 0;
    if (w.blockNumber > prev) tidToWinBlock.set(w.tournamentId, w.blockNumber);
  }

  const missing = tids.filter((tid) => !cache[tid] || (cache[tid].tier !== 10 && cache[tid].tier !== 20));
  console.log(`[tier-logs-v2] unique tournaments=${tids.length} missing tiers=${missing.length}`);

  let solvedFast = 0;
  let solvedSlow = 0;
  const stillMissing = [];

  // Pass 1: fast
  for (let i = 0; i < missing.length; i++) {
    const tid = missing[i];
    const winBlock = tidToWinBlock.get(tid);
    if (!winBlock) continue;

    console.log(`[tier-logs-v2] FAST ${i + 1}/${missing.length} tid=${tid} winBlock=${winBlock}`);
    const found = await scan(provider, Number(tid), winBlock, LOOKBACK_FAST);
    if (found) {
      cache[tid] = { ...found, updatedAtUtc: nowUtcIso(), mode: "fast" };
      solvedFast++;
      saveCache(cache);
    } else {
      stillMissing.push(tid);
    }
  }

  // Pass 2: slow only for misses
  for (let i = 0; i < stillMissing.length; i++) {
    const tid = stillMissing[i];
    const winBlock = tidToWinBlock.get(tid);
    if (!winBlock) continue;

    console.log(`[tier-logs-v2] SLOW ${i + 1}/${stillMissing.length} tid=${tid} winBlock=${winBlock}`);
    const found = await scan(provider, Number(tid), winBlock, LOOKBACK_SLOW);
    if (found) {
      cache[tid] = { ...found, updatedAtUtc: nowUtcIso(), mode: "slow" };
      solvedSlow++;
      saveCache(cache);
    } else {
      cache[tid] = { tier: null, updatedAtUtc: nowUtcIso(), mode: "miss" };
      if ((i + 1) % 25 === 0) saveCache(cache);
    }
  }

  saveCache(cache);

  let unknownTierWins = 0;
  for (const w of wins) {
    w.tier = cache[w.tournamentId]?.tier ?? null;
    if (w.tier !== 10 && w.tier !== 20) unknownTierWins++;
  }

  const byWallet = new Map();
  for (const w of wins) {
    const cur =
      byWallet.get(w.wallet) || { wallet: w.wallet, lvl10Wins: 0, lvl20Wins: 0, unknownWins: 0, lastWin: 0 };

    if (w.timestamp > cur.lastWin) cur.lastWin = w.timestamp;
    if (w.tier === 10) cur.lvl10Wins++;
    else if (w.tier === 20) cur.lvl20Wins++;
    else cur.unknownWins++;

    byWallet.set(w.wallet, cur);
  }

  const leaderboard = [...byWallet.values()]
    .map((x) => ({ ...x, totalWins: x.lvl10Wins + x.lvl20Wins + x.unknownWins }))
    .sort((a, b) => b.totalWins - a.totalWins || b.lastWin - a.lastWin || a.wallet.localeCompare(b.wallet))
    .map((x, i) => ({ rank: i + 1, ...x }));

  const out = {
    updatedAtUtc: nowUtcIso(),
    source: "graph-studio/1.7 + log-tier-cache-v2",
    rpc: RPC_URL,
    tournamentDiamond: DIAMOND,
    totalWins: wins.length,
    uniqueTournaments: tids.length,
    unknownTierWins,
    solvedFast,
    solvedSlow,
    wins,
    leaderboard,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`[tier-logs-v2] wrote ${OUT_FILE}`);
  console.log(`[tier-logs-v2] solvedFast=${solvedFast} solvedSlow=${solvedSlow} unknownTierWins=${unknownTierWins}`);
}

main().catch((e) => {
  console.error("[tier-logs-v2] fatal:", e);
  process.exit(1);
});