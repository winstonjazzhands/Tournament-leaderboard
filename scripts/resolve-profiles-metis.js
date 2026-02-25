// scripts/resolve-profiles-metis.js
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { ethers } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}
function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}
function normAddr(a) {
  return (a || "").toLowerCase();
}
function topicToAddress(topic) {
  // topics are 32-byte left-padded; last 20 bytes is address
  if (!topic || typeof topic !== "string" || !topic.startsWith("0x") || topic.length !== 66) return null;
  return ("0x" + topic.slice(26)).toLowerCase();
}

/**
 * Decode wallet+name from a profile log.
 *
 * Your debug output shows "wallet: null" and the wallet is in data.
 * decode (address,string) works on your samples (even if the contract stores address as uint256).
 */
function decodeWalletAndName(log) {
  // 1) If event had indexed user, it would be topics[1].
  const maybeIndexed = topicToAddress(log.topics?.[1]);

  // 2) Try decode from data as (address,string)
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const [addr, name] = coder.decode(["address", "string"], log.data);
    const wallet = normAddr(addr);
    const n = (name ?? "").toString();
    if (wallet && wallet !== "0x0000000000000000000000000000000000000000") {
      return { wallet, name: n };
    }
  } catch {}

  // 3) Fallback: decode as (uint256,string) and coerce to address (last 20 bytes)
  try {
    const coder = ethers.AbiCoder.defaultAbiCoder();
    const [u, name] = coder.decode(["uint256", "string"], log.data);
    const hex = u.toString(16).padStart(64, "0");
    const wallet = ("0x" + hex.slice(24)).toLowerCase();
    const n = (name ?? "").toString();
    if (wallet && wallet !== "0x0000000000000000000000000000000000000000") {
      return { wallet, name: n };
    }
  } catch {}

  // 4) If we have indexed address but couldn't decode name, keep nothing (no name)
  if (maybeIndexed) return { wallet: maybeIndexed, name: "" };

  return null;
}

async function main() {
  // --- Config (Metis) ---
  const RPC = "https://andromeda.metis.io/?owner=1088";

  // This is what your logs show:
  const PROFILES_CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";
  const TOPIC0 = "0x2c1415cbda85739695d2c281e25308b9c194f40490b09151d6cdf3c1dffd435d";

  // Chunk size for getLogs. Smaller = safer but slower.
  const CHUNK_BLOCKS = 200_000;

  // Where your leaderboard is written by pull-wins script:
  const leaderboardPath = path.resolve(__dirname, "..", "public", "leaderboard.json");

  // Where we write profiles:
  const outPath = path.resolve(__dirname, "..", "public", "profiles.json");

  if (!exists(leaderboardPath)) {
    throw new Error(`Missing leaderboard.json at: ${leaderboardPath}\nRun your wins script first.`);
  }

  const leaderboard = readJson(leaderboardPath);
  const wins = Array.isArray(leaderboard.wins) ? leaderboard.wins : [];

  // Collect wallets from leaderboard wins
  const walletSet = new Set();
  for (const w of wins) {
    const wallet = normAddr(w.wallet);
    if (wallet) walletSet.add(wallet);
  }
  const wallets = [...walletSet].sort();
  console.log(`Loaded ${wallets.length} wallets from leaderboard.`);

  // Load existing cache if present
  let cache = {
    updatedAtUtc: null,
    rpc: RPC,
    profilesContract: PROFILES_CONTRACT,
    namesByAddress: {},
  };
  if (exists(outPath)) {
    try {
      const existing = readJson(outPath);
      if (existing && typeof existing === "object" && existing.namesByAddress) {
        cache = {
          ...cache,
          ...existing,
          namesByAddress: existing.namesByAddress || {},
        };
      }
    } catch {}
  }

  // Ensure keys exist for all wallets
  for (const w of wallets) {
    if (!(w in cache.namesByAddress)) cache.namesByAddress[w] = null;
  }

  const resolved = () => wallets.filter((w) => !!cache.namesByAddress[w]).length;
  console.log(`Cache has ${resolved()} entries.`);
  console.log(`Missing names to resolve: ${wallets.length - resolved()}`);

  const provider = new ethers.JsonRpcProvider(RPC);
  const latest = await provider.getBlockNumber();
  console.log(`Latest block: ${latest}`);
  console.log(`Scanning backwards in chunks of ${CHUNK_BLOCKS.toLocaleString()} blocks...`);
  console.log(`Contract: ${PROFILES_CONTRACT}`);
  console.log(`Topic0: ${TOPIC0}`);

  // We keep the "best" (latest) name by taking the newest log we encounter
  // Since we scan backwards (latest → older), the first time we set a wallet name is the newest.
  let cursor = latest;

  while (cursor >= 0) {
    if (resolved() === wallets.length) break;

    const fromBlock = Math.max(0, cursor - CHUNK_BLOCKS + 1);
    const toBlock = cursor;

    let logs = [];
    try {
      logs = await provider.getLogs({
        address: PROFILES_CONTRACT,
        fromBlock,
        toBlock,
        topics: [TOPIC0],
      });
    } catch (e) {
      // If provider is picky, reduce chunk and continue (simple safety)
      throw new Error(
        `getLogs failed for ${fromBlock} → ${toBlock}: ${e?.message || e}`
      );
    }

    let hit = 0;
    for (const log of logs) {
      const decoded = decodeWalletAndName(log);
      if (!decoded) continue;

      const w = decoded.wallet;
      if (!walletSet.has(w)) continue;

      // If already resolved, skip (we are scanning newest → oldest)
      if (cache.namesByAddress[w]) continue;

      const name = (decoded.name || "").trim();
      if (!name) continue;

      cache.namesByAddress[w] = name;
      hit++;
    }

    console.log(
      `Scanned ${fromBlock} → ${toBlock} | logs=${logs.length} | newlyResolved=${hit} | resolved=${resolved()}/${wallets.length}`
    );

    // Move cursor back
    cursor = fromBlock - 1;
  }

  cache.updatedAtUtc = new Date().toISOString();
  writeJson(outPath, cache);
  console.log(`Wrote ${outPath}`);
  console.log(`Done. Resolved ${resolved()}/${wallets.length}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});