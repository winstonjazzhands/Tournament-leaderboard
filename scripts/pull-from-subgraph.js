/**
 * scripts/pull-from-subgraph-studio.js
 *
 * Standalone version for your Graph Studio endpoint.
 * No environment variables required.
 *
 * Endpoint:
 * https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7
 *
 * Run:
 * node scripts/pull-from-subgraph-studio.js
 */

import fs from "fs";
import path from "path";

// 🔒 HARD-CODED ENDPOINT (your provided URL)
const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const OUT_FILE = path.join(process.cwd(), "public", "leaderboard.json");

const PAGE_SIZE = 1000;
const MAX_PAGES = 2000;

function nowUtcIso() {
  return new Date().toISOString();
}

async function gql(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const json = await res.json();

  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  }
  if (json.errors) {
    throw new Error(`GraphQL error: ${JSON.stringify(json.errors)}`);
  }

  return json.data;
}

function toInt(x) {
  if (x === null || x === undefined) return null;
  const n = Number(x);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function normalizeWallet(w) {
  if (!w) return null;
  if (typeof w === "string") return w.toLowerCase();
  if (typeof w === "object" && w.id) return w.id.toLowerCase();
  return null;
}

function inferTier(win) {
  const maxLevel =
    toInt(win.maxLevel) ||
    toInt(win.levelCap) ||
    toInt(win?.tournament?.maxLevel) ||
    null;

  if (maxLevel === 10) return 10;
  if (maxLevel === 20) return 20;

  if (typeof maxLevel === "number") {
    if (maxLevel <= 12) return 10;
    if (maxLevel >= 18) return 20;
  }

  return null;
}

async function main() {
  console.log("Pulling from Graph Studio...");
  console.log("Endpoint:", SUBGRAPH_URL);

  const winsRaw = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const skip = page * PAGE_SIZE;

    const query = `
      query PullWins($first: Int!, $skip: Int!) {
        tournamentWins(first: $first, skip: $skip) {
          id
          timestamp
          player
          tournamentId
          maxLevel
          tournament {
            id
            maxLevel
          }
        }
      }
    `;

    const data = await gql(query, { first: PAGE_SIZE, skip });

    const batch = data?.tournamentWins || [];
    winsRaw.push(...batch);

    console.log(`Page ${page} → ${batch.length} wins`);

    if (batch.length < PAGE_SIZE) break;
  }

  const wins = winsRaw
    .map((w) => ({
      id: w.id,
      wallet: normalizeWallet(w.player),
      timestamp: toInt(w.timestamp),
      tournamentId: w.tournamentId || w?.tournament?.id || null,
      tier: inferTier(w),
    }))
    .filter((w) => w.wallet && w.timestamp);

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
    .map((x) => ({
      ...x,
      totalWins: x.lvl10Wins + x.lvl20Wins + x.unknownWins,
    }))
    .sort(
      (a, b) =>
        b.totalWins - a.totalWins ||
        b.lastWin - a.lastWin ||
        a.wallet.localeCompare(b.wallet)
    )
    .map((x, i) => ({
      rank: i + 1,
      ...x,
    }));

  const out = {
    updatedAtUtc: nowUtcIso(),
    source: "graph-studio/1.7",
    totalWins: wins.length,
    wins,
    leaderboard,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));

  console.log("Done.");
  console.log("Wins:", wins.length);
  console.log("Wallets:", leaderboard.length);
  console.log("File written:", OUT_FILE);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});