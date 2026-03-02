/**
 * Post-22M tournament tier resolver (subgraph + on-chain logs)
 * Writes: public/leaderboard.json  (NOT scripts/public/...)
 *
 * Adds correct earnings:
 *  lifetimeEarned = sum over weeks (L10 bracket payout + 60 * L20 wins)
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DECODE_VERSION = "post22m-v1-flexpair";

const REWARDS = {
  L20_PER_WIN: 60,
  L10_BRACKETS: [
    { minWins: 10, jewel: 750 },
    { minWins: 5, jewel: 300 },
    { minWins: 3, jewel: 150 },
  ],
};

const CFG = {
  SUBGRAPH_ENDPOINT:
    process.env.SUBGRAPH_ENDPOINT ||
    "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7",

  // accept either name
  RPC:
    process.env.RPC_URL ||
    process.env.RPC ||
    "https://andromeda.metis.io/?owner=1088",

  TOURNAMENT_DIAMOND:
    process.env.TOURNAMENT_DIAMOND ||
    "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B",

  START_BLOCK: Number(process.env.START_BLOCK || "22000000"),
  LOOKBACK_BLOCKS: Number(process.env.LOOKBACK_BLOCKS || "1500000"),
  LOG_CHUNK_BLOCKS: Number(process.env.LOG_CHUNK_BLOCKS || "60000"),
  THROTTLE_MS: Number(process.env.THROTTLE_MS || "0"),

  // ✅ correct output path (repoRoot/public/leaderboard.json)
  OUT_JSON: path.resolve(__dirname, "..", "public", "leaderboard.json"),

  CACHE_DIR: path.resolve(__dirname, ".cache"),
  CACHE_FILE: path.resolve(__dirname, ".cache", "tournament-tier-cache.json"),

  USE_CACHE: (process.env.USE_CACHE ?? "1") === "1",
};

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

function weekStartUtcSeconds(tsSec) {
  const d = new Date(tsSec * 1000);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diffToMonday = (day + 6) % 7; // Mon->0 ... Sun->6
  d.setUTCDate(d.getUTCDate() - diffToMonday);
  d.setUTCHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function l10BracketPayout(winsL10ThatWeek) {
  for (const b of REWARDS.L10_BRACKETS) {
    if (winsL10ThatWeek >= b.minWins) return b.jewel;
  }
  return 0;
}

function loadTierCache() {
  const raw = readJsonSafe(CFG.CACHE_FILE, null);
  const base = { byTournamentId: {} };
  if (!raw || typeof raw !== "object") return base;
  if (raw.byTournamentId && typeof raw.byTournamentId === "object") {
    return { byTournamentId: raw.byTournamentId };
  }
  const migrated = { byTournamentId: {} };
  for (const [k, v] of Object.entries(raw)) {
    if (!/^\d+$/.test(k)) continue;
    if (v === 10 || v === 20) {
      migrated.byTournamentId[k] = {
        tier: v,
        matchedBlock: null,
        resolvedAtUtc: new Date().toISOString(),
        method: "migrated/flat-number",
        decodeVersion: "unknown",
      };
    } else if (v && typeof v === "object") {
      const tier = v.tier === 10 || v.tier === 20 ? v.tier : null;
      migrated.byTournamentId[k] = {
        tier,
        matchedBlock: Number.isFinite(Number(v.matchedBlock)) ? Number(v.matchedBlock) : null,
        resolvedAtUtc: v.resolvedAtUtc || new Date().toISOString(),
        method: v.method || "migrated/object",
        anchorWinBlock: Number.isFinite(Number(v.anchorWinBlock)) ? Number(v.anchorWinBlock) : null,
        error: v.error || null,
        decodeVersion: v.decodeVersion || "unknown",
      };
    }
  }
  return migrated;
}

function inferTierFlexPair(words, tidWord) {
  const tidIdxs = [];
  for (let i = 0; i < words.length; i++) if (words[i] === tidWord) tidIdxs.push(i);
  if (!tidIdxs.length) return null;

  const WINDOW = 40;
  const SPAN = 14;
  const MAX_DRIFT = 4;
  let best = null;

  for (const tidIdx of tidIdxs) {
    const start = Math.max(0, tidIdx - WINDOW);
    const end = Math.min(words.length - 1, tidIdx + WINDOW);

    const ints = [];
    for (let i = start; i <= end; i++) {
      const v = wordToSmallInt(words[i]);
      if (v == null || v < 0 || v > 30) continue;
      ints.push({ idx: i, v });
    }

    for (const a of ints) {
      const min = a.v;
      for (let j = a.idx + 1; j <= Math.min(end, a.idx + SPAN); j++) {
        const max = wordToSmallInt(words[j]);
        if (max !== 10 && max !== 20) continue;
        if (min > max) continue;
        if (max - min > MAX_DRIFT) continue;

        const distToTid = Math.min(Math.abs(a.idx - tidIdx), Math.abs(j - tidIdx));
        const exactBonus = min === max ? 25 : 0;
        const spanBonus = SPAN - (j - a.idx);
        const score = 10_000 - distToTid * 80 + exactBonus + spanBonus;

        if (!best || score > best.score) best = { tier: max, score };
      }
    }
  }
  return best ? best.tier : null;
}

function inferTierNearestUnambiguous(words, tidWord) {
  const tidIdxs = [];
  for (let i = 0; i < words.length; i++) if (words[i] === tidWord) tidIdxs.push(i);
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

    if (seen10 && seen20) continue;

    const target = seen10 ? 10 : seen20 ? 20 : null;
    if (!target) continue;

    for (let i = start; i <= end; i++) {
      const v = wordToSmallInt(words[i]);
      if (v === target) return target;
    }
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

    for (let i = logs.length - 1; i >= 0; i--) {
      const log = logs[i];
      const words = extractWordsFromLog(log);
      if (!words.includes(tidWord)) continue;

      let tier = inferTierFlexPair(words, tidWord);
      if (tier !== 10 && tier !== 20) tier = inferTierNearestUnambiguous(words, tidWord);

      if (tier === 10 || tier === 20) return { tier, matchedBlock: Number(log.blockNumber) };
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
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: { first, skip } }),
    });

    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`Subgraph HTTP ${res.status}: ${txt.slice(0, 300)}`);
    }

    const json = await res.json();
    if (json.errors?.length) throw new Error(`Subgraph errors: ${JSON.stringify(json.errors)}`);

    const batch = json?.data?.tournamentWins || [];
    all.push(...batch);
    console.log(`[post22m] page=${skip / first} batch=${batch.length} total=${all.length}`);

    if (batch.length < first) break;
    skip += first;
  }

  return all;
}

function computeEarnedByWalletFromWins(wins) {
  const weekly = new Map(); // wallet -> weekStart -> {l10,l20}

  const nowSec = Math.floor(Date.now() / 1000);
  const thisWeekStart = weekStartUtcSeconds(nowSec);
  const lastWeekStart = thisWeekStart - 7 * 24 * 60 * 60;

  for (const w of wins) {
    const wallet = toLower0x(w.wallet);
    if (!wallet) continue;
    if (w.tier !== 10 && w.tier !== 20) continue;
    if (!Number.isFinite(Number(w.timestamp))) continue;

    const wk = weekStartUtcSeconds(Number(w.timestamp));

    let walletWeeks = weekly.get(wallet);
    if (!walletWeeks) {
      walletWeeks = new Map();
      weekly.set(wallet, walletWeeks);
    }

    let c = walletWeeks.get(wk);
    if (!c) {
      c = { l10: 0, l20: 0 };
      walletWeeks.set(wk, c);
    }

    if (w.tier === 10) c.l10++;
    else c.l20++;
  }

  const out = new Map(); // wallet -> {lifetime,thisWeek,lastWeek}
  for (const [wallet, weeks] of weekly.entries()) {
    let lifetime = 0;
    let thisWeek = 0;
    let lastWeek = 0;

    for (const [wk, c] of weeks.entries()) {
      const payout = l10BracketPayout(c.l10) + REWARDS.L20_PER_WIN * c.l20;
      lifetime += payout;
      if (wk === thisWeekStart) thisWeek += payout;
      if (wk === lastWeekStart) lastWeek += payout;
    }

    out.set(wallet, { lifetime, thisWeek, lastWeek });
  }

  return out;
}

function aggregateLeaderboardFromWins(wins) {
  const by = new Map();

  for (const w of wins) {
    const wallet = toLower0x(w.wallet);
    if (!wallet) continue;

    const cur = by.get(wallet) || {
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

  const earned = computeEarnedByWalletFromWins(wins);

  return [...by.values()]
    .sort((a, b) => b.totalWins - a.totalWins || b.lastWin - a.lastWin || a.wallet.localeCompare(b.wallet))
    .map((r, i) => {
      const e = earned.get(r.wallet) || { lifetime: 0, thisWeek: 0, lastWeek: 0 };
      return {
        rank: i + 1,
        wallet: r.wallet,
        lvl10Wins: r.lvl10Wins,
        lvl20Wins: r.lvl20Wins,
        totalWins: r.totalWins,
        lastWin: r.lastWin,

        // ✅ correct totals
        lifetimeEarned: e.lifetime,
        thisWeekEarned: e.thisWeek,
        lastWeekEarned: e.lastWeek,
      };
    });
}

async function main() {
  console.log(`[post22m] subgraph: ${CFG.SUBGRAPH_ENDPOINT}`);
  console.log(`[post22m] rpc: ${CFG.RPC}`);
  console.log(`[post22m] diamond: ${CFG.TOURNAMENT_DIAMOND}`);
  console.log(`[post22m] startBlock: ${CFG.START_BLOCK}`);
  console.log(`[post22m] lookbackBlocks: ${CFG.LOOKBACK_BLOCKS}`);
  console.log(`[post22m] logChunkBlocks: ${CFG.LOG_CHUNK_BLOCKS}`);
  console.log(`[post22m] decodeVersion: ${DECODE_VERSION}`);
  console.log(`[post22m] useCache: ${CFG.USE_CACHE}`);

  ensureDir(CFG.CACHE_DIR);
  const cache = loadTierCache();

  const provider = new ethers.JsonRpcProvider(CFG.RPC);
  const diamond = ethers.getAddress(CFG.TOURNAMENT_DIAMOND);

  const rawWins = await gqlFetchAllTournamentWins(CFG.SUBGRAPH_ENDPOINT);

  const wins = rawWins
    .map((w) => ({
      id: w.id,
      tournamentId: Number(w.tournamentId),
      timestamp: Number(w.timestamp),
      blockNumber: Number(w.blockNumber),
      wallet: toLower0x(w?.player?.id),
    }))
    .filter((w) => w.wallet && Number.isFinite(w.tournamentId) && Number.isFinite(w.timestamp) && Number.isFinite(w.blockNumber))
    .filter((w) => w.blockNumber >= CFG.START_BLOCK);

  const tidToWinBlock = new Map();
  for (const w of wins) if (!tidToWinBlock.has(w.tournamentId)) tidToWinBlock.set(w.tournamentId, w.blockNumber);
  const tids = [...tidToWinBlock.keys()].sort((a, b) => a - b);

  console.log(`[post22m] wins(post)=${wins.length} uniqueTournaments(post)=${tids.length}`);

  for (let i = 0; i < tids.length; i++) {
    const tid = tids[i];
    const winBlock = tidToWinBlock.get(tid);

    const cached = cache.byTournamentId?.[String(tid)];
    const cachedTier = cached?.tier;

    if (CFG.USE_CACHE && (cachedTier === 10 || cachedTier === 20) && cached?.decodeVersion === DECODE_VERSION) {
      continue;
    }

    console.log(`[post22m] ${i + 1}/${tids.length} tid=${tid} winBlock=${winBlock}`);

    const found = await findTierByLookback({ provider, diamond, tournamentId: tid, winBlock });

    cache.byTournamentId = cache.byTournamentId || {};
    if (found?.tier === 10 || found?.tier === 20) {
      cache.byTournamentId[String(tid)] = {
        tier: found.tier,
        matchedBlock: found.matchedBlock,
        anchorWinBlock: winBlock,
        method: "logs/lookback",
        resolvedAtUtc: new Date().toISOString(),
        decodeVersion: DECODE_VERSION,
      };
      console.log(`[post22m]  ✅ tier=${found.tier} matchedBlock=${found.matchedBlock}`);
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
      console.log(`[post22m]  ⚠️ unknown tier`);
    }
  }

  writeJsonPretty(CFG.CACHE_FILE, cache);

  let unknownTierWins = 0;
  for (const w of wins) {
    const entry = cache.byTournamentId?.[String(w.tournamentId)];
    const tier = entry?.tier;
    if (tier === 10 || tier === 20) w.tier = tier;
    else {
      w.tier = null;
      unknownTierWins++;
    }
  }

  const leaderboard = aggregateLeaderboardFromWins(wins);

  const out = {
    updatedAtUtc: new Date().toISOString(),
    decodeVersion: DECODE_VERSION,
    startBlock: CFG.START_BLOCK,
    lookbackBlocks: CFG.LOOKBACK_BLOCKS,
    logChunkBlocks: CFG.LOG_CHUNK_BLOCKS,
    totalWins: wins.length,
    uniqueTournaments: tids.length,
    unknownTierWins,
    rewards: {
      lvl10Brackets: REWARDS.L10_BRACKETS,
      lvl20PerWin: REWARDS.L20_PER_WIN,
      weekStart: "Monday 00:00 UTC",
      earnedDefinition: "Sum of weekly payouts over time (L10 bracket per week + L20 per-win per week).",
    },
    wins: wins.map((w) => ({
      id: w.id,
      tournamentId: w.tournamentId,
      wallet: w.wallet,
      timestamp: w.timestamp,
      blockNumber: w.blockNumber,
      tier: w.tier,
    })),
    leaderboard,
  };

  ensureDir(path.dirname(CFG.OUT_JSON));
  writeJsonPretty(CFG.OUT_JSON, out);
  console.log(`[post22m] wrote ${CFG.OUT_JSON}`);
}

main().catch((e) => {
  console.error(`[post22m] fatal:`, e);
  process.exitCode = 1;
});