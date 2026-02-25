/**
 * scripts/pull-from-subgraph-studio-v2.js
 *
 * Uses your proven-working query shape:
 * tournamentWins { id timestamp tournamentId player { id } }
 *
 * Writes public/leaderboard.json containing BOTH:
 *  - wins[] raw events (strict UTC filtering)
 *  - leaderboard[] aggregated all-time
 *
 * Run:
 * node scripts/pull-from-subgraph-studio-v2.js
 */

import fs from "fs";
import path from "path";

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const OUT_FILE = path.join(process.cwd(), "public", "leaderboard.json");

// Pagination
const PAGE_SIZE = 1000;
const MAX_PAGES = 5000; // safety

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

// Handles: player { id } OR string wallet OR {id}
function normalizeWallet(player) {
  if (!player) return null;
  if (typeof player === "string") return player.toLowerCase();
  if (typeof player === "object") {
    const id = player.id || player.address || player.wallet || null;
    return typeof id === "string" ? id.toLowerCase() : null;
  }
  return null;
}

// Right now we only have tournamentId + player + timestamp.
// Tier (10/20) isn't available in your sample query, so we mark unknown.
// Later we can enrich tier by joining tournament settings if schema supports it.
function inferTier(_win) {
  return null; // unknown for now
}

async function main() {
  console.log("[pull-v2] Endpoint:", SUBGRAPH_URL);

  const winsRaw = [];

  // Use orderBy: timestamp asc so pagination is stable with skip/first
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
    if (!Array.isArray(batch)) {
      throw new Error("Unexpected tournamentWins shape: " + JSON.stringify(batch)?.slice(0, 500));
    }

    winsRaw.push(...batch);
    console.log(`[pull-v2] page=${page} skip=${skip} batch=${batch.length} total=${winsRaw.length}`);

    if (batch.length < PAGE_SIZE) break;
  }

  const wins = winsRaw
    .map((w) => {
      const wallet = normalizeWallet(w.player);
      const timestamp = toInt(w.timestamp);
      const tournamentId = w.tournamentId != null ? String(w.tournamentId) : null;

      return {
        id: w.id != null ? String(w.id) : null,
        wallet,
        timestamp, // unix seconds
        tournamentId,
        tier: inferTier(w), // null for now
      };
    })
    .filter((w) => w.wallet && w.timestamp);

  // Aggregate
  const byWallet = new Map();
  let unknownTierWins = 0;

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

    if (w.tier === 10) cur.lvl10Wins += 1;
    else if (w.tier === 20) cur.lvl20Wins += 1;
    else {
      cur.unknownWins += 1;
      unknownTierWins += 1;
    }

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
    source: "graph-studio/1.7",
    rpc: "https://andromeda.metis.io/?owner=1088",
    tournamentDiamond: "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B",
    totalWins: wins.length,
    uniqueTournaments: new Set(wins.map((w) => w.tournamentId).filter(Boolean)).size,
    unknownTierWins,
    wins,
    leaderboard,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log(`[pull-v2] wrote ${OUT_FILE}`);
  console.log(`[pull-v2] wins=${wins.length} wallets=${leaderboard.length} unknownTierWins=${unknownTierWins}`);
}

main().catch((e) => {
  console.error("[pull-v2] fatal:", e);
  process.exit(1);
});