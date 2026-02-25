// scripts/resolve-profiles-metis-backfill.js
// Backfills profile names for leaderboard wallets by scanning logs backwards.
// Event we know: ProfileCreated(address,string) where wallet is NOT indexed in topics.
// Decodes log.data as (address,string).
//
// Note: Many wallets may have no profile events at all. In that case they will remain unnamed.

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const PROFILES_CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";
const TOPIC0 =
  "0x2c1415cbda85739695d2c281e25308b9c194f40490b09151d6cdf3c1dffd435d";

const ROOT = process.cwd();
const LEADERBOARD = path.join(ROOT, "public", "leaderboard.json");
const OUTPUT = path.join(ROOT, "public", "profiles.json");
const CACHE_PATH = path.join(ROOT, "scripts", ".cache", "profiles-cache.json");

const CHUNK = 200_000;

const provider = new ethers.JsonRpcProvider(RPC);
const coder = ethers.AbiCoder.defaultAbiCoder();

function safeLower(s) {
  return (s || "").toLowerCase();
}
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return { namesByAddress: {}, cursor: null, finished: false };
    const j = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
    return {
      namesByAddress: j.namesByAddress || {},
      cursor: typeof j.cursor === "number" ? j.cursor : null,
      finished: j.finished === true,
    };
  } catch {
    return { namesByAddress: {}, cursor: null, finished: false };
  }
}
function saveCache(cache) {
  ensureDir(path.dirname(CACHE_PATH));
  fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
}

async function main() {
  const force = process.argv.includes("--force");
  if (!fs.existsSync(LEADERBOARD)) {
    throw new Error("public/leaderboard.json not found. Run leaderboard build first.");
  }

  const lb = JSON.parse(fs.readFileSync(LEADERBOARD, "utf8"));
  const wins = Array.isArray(lb.wins) ? lb.wins : [];

  const target = new Set();
  for (const w of wins) {
    if (w.wallet) target.add(safeLower(w.wallet));
  }
  console.log(`Loaded ${target.size} wallets from leaderboard.`);

  const latest = await provider.getBlockNumber();
  console.log("Latest block:", latest);

  const cache = loadCache();

  if (force) {
    console.log("Forcing rescan: clearing cursor + finished flag (keeping names).");
    cache.cursor = null;
    cache.finished = false;
    saveCache(cache);
  }

  const namesByAddress = cache.namesByAddress || {};
  const missing = new Set([...target].filter((w) => !namesByAddress[w]));

  console.log(`Cache has ${Object.keys(namesByAddress).length} entries.`);
  console.log(`Missing names to resolve: ${missing.size}`);

  if (cache.finished) {
    console.log("Cache indicates we've already scanned to block 0. Nothing more to scan.");
    writeOutput(target, namesByAddress);
    return;
  }

  let cursor = typeof cache.cursor === "number" ? cache.cursor : latest;
  if (cursor < 0) cursor = latest;

  console.log("Starting backward scan cursor:", cursor);

  while (cursor > 0 && missing.size > 0) {
    const fromBlock = Math.max(0, cursor - CHUNK);

    const logs = await provider.getLogs({
      address: PROFILES_CONTRACT,
      fromBlock,
      toBlock: cursor,
      topics: [TOPIC0],
    });

    for (const log of logs) {
      let addr, name;
      try {
        [addr, name] = coder.decode(["address", "string"], log.data);
      } catch {
        continue;
      }

      const wallet = safeLower(addr);
      if (!target.has(wallet)) continue;

      const cleaned = String(name || "").trim();
      if (!cleaned) continue;

      if (!namesByAddress[wallet]) {
        namesByAddress[wallet] = cleaned;
        missing.delete(wallet);
      }
    }

    console.log(
      `Scanned ${fromBlock} → ${cursor} | logs=${logs.length} | resolved=${target.size - missing.size}/${target.size}`
    );

    cursor = fromBlock - 1;

    cache.namesByAddress = namesByAddress;
    cache.cursor = cursor;
    saveCache(cache);
  }

  if (cursor <= 0) {
    cache.finished = true;
    cache.cursor = -1;
    cache.namesByAddress = namesByAddress;
    saveCache(cache);
    console.log("Reached block 0. Marked cache as finished.");
  }

  writeOutput(target, namesByAddress);
}

function writeOutput(targetSet, namesByAddress) {
  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "metis_logs_profilecreated_backward",
    rpc: RPC,
    profilesContract: PROFILES_CONTRACT,
    topic0: TOPIC0,
    matchedWalletsInLeaderboard: targetSet.size,
    resolvedNames: [...targetSet].filter((w) => namesByAddress[w]).length,
    namesByAddress,
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT}`);
  console.log(`Done. Resolved ${out.resolvedNames}/${targetSet.size}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});