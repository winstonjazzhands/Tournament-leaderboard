// scripts/resolve-profiles-community-api.js
// Resolve wallet -> display name using a DFK community GraphQL API.
// Robust wallet extraction from leaderboard.json (handles multiple field names).

import fs from "fs";
import path from "path";

const ROOT = process.cwd();

const PUBLIC_DIR = path.join(ROOT, "public");
const SCRIPTS_DIR = path.join(ROOT, "scripts");
const CACHE_DIR = path.join(SCRIPTS_DIR, ".cache");

const LEADERBOARD_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const PROFILES_PATH = path.join(PUBLIC_DIR, "profiles.json");
const CACHE_PATH = path.join(CACHE_DIR, "profiles-name-cache.json");

// Override via env if you want
const API_URLS = [
  process.env.COMMUNITY_API_URL,
  "https://api.defikingdoms.com/graphql",
  "https://community-api.defikingdoms.com/graphql",
].filter(Boolean);

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJson(p, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function normalizeAddr(a) {
  const s = String(a || "").trim();
  if (!s) return "";
  // Keep lowercase 0x... addresses
  return s.toLowerCase();
}

// Tries many likely wallet field names in a win row.
// (Your wins script may output different shapes over time.)
function extractWalletFromWinRow(w) {
  if (!w || typeof w !== "object") return "";

  // common direct fields
  const candidates = [
    w.player,
    w.wallet,
    w.address,
    w.winner,
    w.winnerAddress,
    w.playerAddress,
    w.walletAddress,
  ];

  for (const c of candidates) {
    const addr = normalizeAddr(c);
    if (addr.startsWith("0x") && addr.length === 42) return addr;
  }

  // sometimes nested objects like { player: { id: "0x..." } }
  const nested = [
    w.player?.id,
    w.player?.address,
    w.wallet?.id,
    w.wallet?.address,
    w.winner?.id,
    w.winner?.address,
  ];
  for (const c of nested) {
    const addr = normalizeAddr(c);
    if (addr.startsWith("0x") && addr.length === 42) return addr;
  }

  return "";
}

function loadWalletsFromLeaderboard() {
  const lb = readJson(LEADERBOARD_PATH, null);
  if (!lb) return [];

  // expected: { wins: [...] }
  const wins = Array.isArray(lb.wins) ? lb.wins : [];
  const wallets = wins
    .map(extractWalletFromWinRow)
    .filter((a) => a.startsWith("0x") && a.length === 42);

  return uniq(wallets);
}

async function gql(url, query, variables) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }

  if (json.errors?.length) {
    const msg = json.errors.map((e) => e.message).join(" | ");
    throw new Error(msg);
  }

  return json.data;
}

// IMPORTANT: ids must be typed as GraphQL ID, not String
const CANDIDATE_QUERIES = [
  {
    name: "profiles(where: { id_in })",
    query: `
      query($ids: [ID!]!) {
        profiles(where: { id_in: $ids }) {
          id
          name
        }
      }
    `,
    pick: (data) => data?.profiles,
  },
  {
    name: "players(where: { id_in })",
    query: `
      query($ids: [ID!]!) {
        players(where: { id_in: $ids }) {
          id
          name
        }
      }
    `,
    pick: (data) => data?.players,
  },
];

async function resolveBatch(ids) {
  let lastErr = null;

  for (const apiUrl of API_URLS) {
    for (const cand of CANDIDATE_QUERIES) {
      try {
        const data = await gql(apiUrl, cand.query, { ids });
        const rows = cand.pick(data);
        if (!rows) continue;

        const list = Array.isArray(rows) ? rows : [rows];
        const out = {};
        for (const r of list) {
          const id = normalizeAddr(r?.id);
          const name = String(r?.name || "").trim();
          if (id && name) out[id] = name;
        }

        return out;
      } catch (e) {
        lastErr = e;
      }
    }
  }

  throw lastErr || new Error("Unable to resolve profiles: no query shape matched.");
}

async function main() {
  ensureDir(CACHE_DIR);

  const wallets = loadWalletsFromLeaderboard();
  console.log(`Loaded wallets: ${wallets.length}`);

  const cache = readJson(CACHE_PATH, { namesByAddress: {} });
  cache.namesByAddress = cache.namesByAddress || {};

  const existing = readJson(PROFILES_PATH, { namesByAddress: {} });
  existing.namesByAddress = existing.namesByAddress || {};

  const namesByAddress = { ...existing.namesByAddress, ...cache.namesByAddress };

  const missing = wallets.filter((w) => !namesByAddress[w]);
  console.log(`Cache has ${Object.keys(cache.namesByAddress).length} entries.`);
  console.log(`Missing names to resolve: ${missing.length}`);

  if (wallets.length === 0) {
    console.log(
      "⚠️ No wallets detected in public/leaderboard.json. " +
        "That usually means the wins file format changed (or is empty)."
    );
  }

  if (missing.length === 0) {
    writeJson(PROFILES_PATH, { namesByAddress });
    console.log(`Wrote ${PROFILES_PATH}`);
    return;
  }

  const BATCH_SIZE = Number(process.env.PROFILE_BATCH_SIZE || 50);
  const batches = [];
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    batches.push(missing.slice(i, i + BATCH_SIZE));
  }

  let resolvedCount = 0;
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    console.log(`Batch ${i + 1}/${batches.length} | requested=${batch.length}`);

    const resolved = await resolveBatch(batch);

    for (const [addr, name] of Object.entries(resolved)) {
      if (!namesByAddress[addr]) resolvedCount++;
      namesByAddress[addr] = name;
    }
  }

  cache.namesByAddress = namesByAddress;
  writeJson(CACHE_PATH, cache);
  writeJson(PROFILES_PATH, { namesByAddress });

  console.log(`Resolved ${resolvedCount} new.`);
  console.log(`Wrote ${PROFILES_PATH}`);
  console.log(`Cache saved: ${CACHE_PATH}`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exit(1);
});