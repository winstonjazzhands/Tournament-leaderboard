/**
 * scripts/pull-wins-and-tier-from-chain.js
 *
 * 1) Pull raw TournamentWin events from your Graph Studio subgraph
 * 2) For each unique tournamentId, query the Tournament Diamond on-chain for entry settings
 * 3) Infer tier from maxLevel (10 vs 20) and cache results locally
 * 4) Write public/leaderboard.json with:
 *    - wins[] raw events (timestamped, strict UTC filtering)
 *    - leaderboard[] aggregated split into lvl10Wins/lvl20Wins
 *
 * Run:
 *   node scripts/pull-wins-and-tier-from-chain.js
 *
 * Notes:
 * - Requires ethers v6 installed in your project.
 * - Caches tournament tiers in ./scripts/.cache/tournament-tier-cache.json
 */

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

// === Your known endpoints / contracts ===
const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const TOURNAMENT_DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const OUT_FILE = path.join(process.cwd(), "public", "leaderboard.json");
const CACHE_DIR = path.join(process.cwd(), "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "tournament-tier-cache.json");

// Subgraph pagination
const PAGE_SIZE = 1000;
const MAX_PAGES = 8000;

// Chain call throttling
const CONCURRENCY = 4;

// === Helpers ===
function nowUtcIso() {
  return new Date().toISOString();
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

function loadCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      const raw = fs.readFileSync(CACHE_FILE, "utf8");
      const obj = JSON.parse(raw);
      if (obj && typeof obj === "object") return obj;
    }
  } catch {}
  return {};
}

function saveCache(cache) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

/**
 * IMPORTANT:
 * We need the correct ABI signature for the function that returns min/max levels.
 *
 * You previously used selectors like 0x4685cc3d, but got zeros.
 * We will try multiple plausible signatures (overloads) by calling via Interface + provider.call.
 *
 * We’ll attempt these in order until one returns non-zero maxLevel for at least one tournamentId:
 *  - getTournamentEntrySettings(uint256)
 *  - getTournamentEntrySettings(uint32)
 *  - getTournamentEntrySettings(uint16)
 *
 * And we’ll decode as (minLevel,maxLevel,...) by reading the first two uint256 words if necessary.
 */

// Known candidate signatures
const CANDIDATE_SIGS = [
  "function getTournamentEntrySettings(uint256 tournamentId) view returns (uint256 minLevel, uint256 maxLevel)",
  "function getTournamentEntrySettings(uint256 tournamentId) view returns (uint256, uint256, uint256, uint256, uint256, uint256)",
  "function getTournamentEntrySettings(uint32 tournamentId) view returns (uint256 minLevel, uint256 maxLevel)",
  "function getTournamentEntrySettings(uint32 tournamentId) view returns (uint256, uint256, uint256, uint256, uint256, uint256)",
  "function getTournamentEntrySettings(uint16 tournamentId) view returns (uint256 minLevel, uint256 maxLevel)",
  "function getTournamentEntrySettings(uint16 tournamentId) view returns (uint256, uint256, uint256, uint256, uint256, uint256)",
];

// Create Interfaces for each candidate
const CANDIDATE_IFACES = CANDIDATE_SIGS.map((s) => new ethers.Interface([s]));

// Try to decode min/max from returned bytes
function decodeMinMax(returnData) {
  if (!returnData || returnData === "0x") return null;
  // return is ABI-encoded. If at least 2 words, we can read first two uint256.
  try {
    const bytes = ethers.getBytes(returnData);
    if (bytes.length < 64) return null;
    const min = ethers.toBigInt(returnData.slice(0, 2 + 64));
    const max = ethers.toBigInt("0x" + returnData.slice(2 + 64, 2 + 64 + 64));
    return { minLevel: Number(min), maxLevel: Number(max) };
  } catch {
    return null;
  }
}

async function callEntrySettings(provider, tournamentId) {
  // Try each candidate signature until one gives sane values.
  for (const iface of CANDIDATE_IFACES) {
    const frag = iface.fragments[0];
    const fnName = frag.name;

    let calldata;
    try {
      calldata = iface.encodeFunctionData(fnName, [tournamentId]);
    } catch {
      continue;
    }

    let ret;
    try {
      ret = await provider.call({ to: TOURNAMENT_DIAMOND, data: calldata });
    } catch {
      continue;
    }

    // First, try normal decode (works if return count matches)
    try {
      const decoded = iface.decodeFunctionResult(fnName, ret);
      // decoded may be array-like
      const minLevel = Number(decoded[0]);
      const maxLevel = Number(decoded[1]);
      if (Number.isFinite(minLevel) && Number.isFinite(maxLevel)) {
        // accept if not both zero (zero/zero is suspicious)
        if (!(minLevel === 0 && maxLevel === 0)) {
          return { minLevel, maxLevel, via: iface.format() };
        }
      }
    } catch {
      // fallthrough
    }

    // Fallback decode as first two uint256 words
    const mm = decodeMinMax(ret);
    if (mm && !(mm.minLevel === 0 && mm.maxLevel === 0)) {
      return { ...mm, via: iface.format() };
    }
  }

  // If everything fails, return null
  return null;
}

function tierFromMaxLevel(maxLevel) {
  if (maxLevel === 10) return 10;
  if (maxLevel === 20) return 20;
  if (typeof maxLevel === "number") {
    if (maxLevel <= 12) return 10;
    if (maxLevel >= 18) return 20;
  }
  return null;
}

async function mapWithConcurrency(items, worker, concurrency) {
  const results = new Array(items.length);
  let idx = 0;

  async function runner() {
    while (true) {
      const i = idx++;
      if (i >= items.length) break;
      results[i] = await worker(items[i], i);
    }
  }

  const runners = Array.from({ length: concurrency }, () => runner());
  await Promise.all(runners);
  return results;
}

async function main() {
  console.log("[pull-tier] subgraph:", SUBGRAPH_URL);
  console.log("[pull-tier] rpc:", RPC_URL);
  console.log("[pull-tier] diamond:", TOURNAMENT_DIAMOND);

  // 1) Pull wins from subgraph (using your proven shape)
  const winsRaw = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;

    const query = `
      query PullWins($first: Int!, $skip: Int!) {
        tournamentWins(first: $first, skip: $skip, orderBy: timestamp, orderDirection: asc) {
          id
          timestamp
          tournamentId
          player { id }
        }
      }
    `;

    const data = await gql(query, { first: PAGE_SIZE, skip });
    const batch = data?.tournamentWins || [];
    if (!Array.isArray(batch)) throw new Error("Unexpected tournamentWins shape");
    winsRaw.push(...batch);

    console.log(`[pull-tier] page=${page} batch=${batch.length} total=${winsRaw.length}`);
    if (batch.length < PAGE_SIZE) break;
  }

  const wins = winsRaw
    .map((w) => ({
      id: w.id != null ? String(w.id) : null,
      wallet: normalizeWallet(w.player),
      timestamp: toInt(w.timestamp),
      tournamentId: w.tournamentId != null ? String(w.tournamentId) : null,
      tier: null, // fill after chain lookups
    }))
    .filter((w) => w.wallet && w.timestamp && w.tournamentId);

  console.log(`[pull-tier] normalized wins=${wins.length}`);

  // 2) Build unique tournament ids
  const tournamentIds = [...new Set(wins.map((w) => w.tournamentId))];
  console.log(`[pull-tier] unique tournamentIds=${tournamentIds.length}`);

  // 3) Load cache and figure out what we need to query
  const cache = loadCache(); // { [tournamentId]: { tier, maxLevel, minLevel, updatedAtUtc, via } }
  const missing = tournamentIds.filter((id) => !cache[id] || cache[id].tier == null);

  console.log(`[pull-tier] cached=${tournamentIds.length - missing.length} missing=${missing.length}`);
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  // 4) Query chain for missing tournamentIds
  const provider = new ethers.JsonRpcProvider(RPC_URL);

  // We’ll test the call mechanism on the first missing id to see if we get sane data.
  if (missing.length) {
    console.log("[pull-tier] probing chain call on first missing tournamentId:", missing[0]);
    const probe = await callEntrySettings(provider, Number(missing[0]));
    if (!probe) {
      console.log("[pull-tier] WARNING: Could not fetch entry settings via any candidate signature.");
      console.log("[pull-tier] Result will have unknown tiers (all will be unknownWins).");
    } else {
      console.log("[pull-tier] probe success:", probe);
    }
  }

  await mapWithConcurrency(
    missing,
    async (tid) => {
      const tidNum = Number(tid);
      if (!Number.isFinite(tidNum)) return;

      const settings = await callEntrySettings(provider, tidNum);
      if (!settings) {
        cache[tid] = {
          tier: null,
          minLevel: null,
          maxLevel: null,
          updatedAtUtc: nowUtcIso(),
          via: null,
        };
        return;
      }

      const tier = tierFromMaxLevel(settings.maxLevel);

      cache[tid] = {
        tier,
        minLevel: settings.minLevel,
        maxLevel: settings.maxLevel,
        updatedAtUtc: nowUtcIso(),
        via: settings.via,
      };
    },
    CONCURRENCY
  );

  saveCache(cache);
  console.log("[pull-tier] cache saved:", CACHE_FILE);

  // 5) Apply tiers to wins
  let unknownTierWins = 0;
  for (const w of wins) {
    const c = cache[w.tournamentId];
    w.tier = c?.tier ?? null;
    if (w.tier !== 10 && w.tier !== 20) unknownTierWins++;
  }

  // 6) Aggregate leaderboard
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
    source: "graph-studio/1.7 + chain-tier-cache",
    rpc: RPC_URL,
    tournamentDiamond: TOURNAMENT_DIAMOND,
    totalWins: wins.length,
    uniqueTournaments: tournamentIds.length,
    unknownTierWins,
    wins,
    leaderboard,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`[pull-tier] wrote ${OUT_FILE}`);
  console.log(`[pull-tier] wins=${wins.length} wallets=${leaderboard.length} unknownTierWins=${unknownTierWins}`);
}

main().catch((e) => {
  console.error("[pull-tier] fatal:", e);
  process.exit(1);
});