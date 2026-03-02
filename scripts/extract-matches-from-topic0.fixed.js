// scripts/extract-matches-from-topic0.js
// Extract match rows from a "match-ish" topic0 and attach winners using a separate "winner hint" topic0.
//
// Supports TWO common shapes we've seen in this repo:
//
// Shape A (matchId is indexed):
//   matchLog.topics = [topic0, matchId, playerA, playerB]
//   matchLog.data   = [resultCode] (optional)
//   hintLog.topics  = [hintTopic0, matchId, winnerAddress]
//
// Shape B (tournamentId indexed, matchId in data):
//   matchLog.topics = [topic0, tournamentId, playerA, playerB]
//   matchLog.data   = [matchId, resultCode]   OR   [resultCode, matchId]
//   hintLog.topics  = [hintTopic0, matchId, winnerAddress]
//
// If we can't join by matchId, we also try a SAFE txHash fallback:
//   If a tx has exactly one hint-winner that matches either playerA or playerB, we assign it.

import fs from "fs";
import path from "path";
import { JsonRpcProvider } from "ethers";

const DIAMOND = (process.env.TOURNAMENT_DIAMOND || "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();
const RPC_URL = process.env.RPC_URL;

if (!RPC_URL) {
  console.error("❌ Missing RPC_URL env var");
  process.exit(1);
}

const MATCH_TOPIC0 = (process.argv[2] || "").toLowerCase();
if (!MATCH_TOPIC0.startsWith("0x") || MATCH_TOPIC0.length !== 66) {
  console.error("Usage: node scripts/extract-matches-from-topic0.js <MATCH_TOPIC0> [HINT_TOPIC0] [LOOKBACK_BLOCKS] [CHUNK_BLOCKS] [OUTFILE]");
  process.exit(1);
}

const HINT_TOPIC0 = (process.argv[3] || "0x9ed8f9aac14f45bbc703fe9922e91c5db62b94877aeb6384e861d8d8c75db032").toLowerCase();
const LOOKBACK = Number(process.argv[4] || 1_000_000);  // default: 1M blocks
const CHUNK = Number(process.argv[5] || 5_000);
const OUTFILE = process.argv[6] || "public/matches.json";

function addrFromTopic(t) {
  return "0x" + t.slice(-40).toLowerCase();
}

function hexToBigInt(h) {
  if (!h || typeof h !== "string") return null;
  try {
    return BigInt(h);
  } catch {
    return null;
  }
}

function decodeDataWords(dataHex) {
  // returns array of 32-byte hex words (0x...64)
  if (!dataHex || dataHex === "0x") return [];
  const hex = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (hex.length % 64 !== 0) return []; // defensive
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push("0x" + hex.slice(i, i + 64));
  return out;
}

function pickMatchIdFromMatchLog(topics, dataWords) {
  // topics: [topic0, x, playerA, playerB]
  // If topics[1] looks like a big matchId (often > 10000), use it.
  // If topics[1] is a small tournamentId (like 1971), try to find matchId in data.
  const t1 = hexToBigInt(topics?.[1]);
  if (t1 == null) return null;

  // Heuristic threshold: tournamentId values are small (<= 10k-ish). matchId/boutId can be large.
  const TOPIC1_IS_TOURNAMENT_ID = t1 <= 20_000n;

  if (!TOPIC1_IS_TOURNAMENT_ID) {
    return t1.toString(); // matchId directly
  }

  // Try data-based matchId discovery.
  // Typical: one word is a small resultCode (<= 10), the other is a big matchId.
  const nums = dataWords.map(hexToBigInt).filter((x) => x != null);
  if (nums.length === 0) return null;

  // If there are 2+ words, pick the biggest as matchId, as long as it's meaningfully bigger than a result code.
  if (nums.length >= 2) {
    // choose the max
    let max = nums[0];
    for (const n of nums) if (n > max) max = n;

    // sanity: max should not look like a tiny code
    if (max > 20_000n) return max.toString();

    // otherwise maybe it's truly small (rare) — treat word0 as matchId anyway
    return nums[0].toString();
  }

  // Single word case: could be matchId or resultCode. If it's big, treat as matchId.
  if (nums[0] > 20_000n) return nums[0].toString();
  return null;
}

function pickResultCodeFromMatchLog(dataWords) {
  const nums = dataWords.map(hexToBigInt).filter((x) => x != null);
  if (nums.length === 0) return null;
  // find a small integer (<= 10) if present
  for (const n of nums) {
    if (n >= 0n && n <= 10n) return Number(n);
  }
  return null;
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - LOOKBACK);
  const toBlock = latest;

  console.log("diamond:", DIAMOND);
  console.log("match topic0:", MATCH_TOPIC0);
  console.log("winner hint topic0:", HINT_TOPIC0);
  console.log("scan:", fromBlock, "->", toBlock);

  const winnersByMatchId = new Map(); // matchId(string) -> winnerAddress
  const hintWinnersByTx = new Map();  // txHash -> Set<winnerAddr>
  let hintLogs = 0;
  let hintFlag1Logs = 0;

  // Pass 1: scan hint logs to map matchId -> winner
  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(toBlock, start + CHUNK - 1);
    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: start,
      toBlock: end,
      topics: [HINT_TOPIC0],
    });

    hintLogs += logs.length;
    for (const log of logs) {
      // Expected: topics = [topic0, matchId, winnerAddr]
      if (!log.topics || log.topics.length < 3) continue;

      const matchId = hexToBigInt(log.topics[1]);
      const winnerAddr = addrFromTopic(log.topics[2]);

      // Optional filter: many hint logs have w[1] == 1 (flag). Keep stats but DO NOT require it.
      const words = decodeDataWords(log.data);
      const w1 = words.length >= 2 ? hexToBigInt(words[1]) : null;
      if (w1 === 1n) hintFlag1Logs++;

      if (matchId != null) winnersByMatchId.set(matchId.toString(), winnerAddr);

      const tx = (log.transactionHash || "").toLowerCase();
      if (tx) {
        if (!hintWinnersByTx.has(tx)) hintWinnersByTx.set(tx, new Set());
        hintWinnersByTx.get(tx).add(winnerAddr);
      }
    }

    process.stdout.write(`\rhint blocks ${start}..${end} logs=${logs.length} hintLogs=${hintLogs} winnersMapped=${winnersByMatchId.size}   `);
  }
  process.stdout.write("\n");

  // Pass 2: scan match logs and attach winners
  const matches = [];
  let matchLogs = 0;
  let winnersFound = 0;
  let winnersFoundById = 0;
  let winnersFoundByTx = 0;
  let winnerNotAorB = 0;

  for (let start = fromBlock; start <= toBlock; start += CHUNK) {
    const end = Math.min(toBlock, start + CHUNK - 1);
    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: start,
      toBlock: end,
      topics: [MATCH_TOPIC0],
    });

    matchLogs += logs.length;

    for (const log of logs) {
      if (!log.topics || log.topics.length < 4) continue;

      const topics = log.topics.map((t) => (t || "").toLowerCase());
      const playerA = addrFromTopic(topics[2]);
      const playerB = addrFromTopic(topics[3]);
      const dataWords = decodeDataWords(log.data);

      const matchId = pickMatchIdFromMatchLog(topics, dataWords);
      const resultCode = pickResultCodeFromMatchLog(dataWords);

      let winner = null;

      // Join by matchId first
      if (matchId && winnersByMatchId.has(matchId)) {
        winner = winnersByMatchId.get(matchId);
        winnersFound++;
        winnersFoundById++;
      } else {
        // Safe txHash fallback:
        // if tx has exactly ONE unique winner address and it's either A or B, use it.
        const tx = (log.transactionHash || "").toLowerCase();
        const set = tx ? hintWinnersByTx.get(tx) : null;
        if (set && set.size === 1) {
          const only = [...set][0];
          if (only === playerA || only === playerB) {
            winner = only;
            winnersFound++;
            winnersFoundByTx++;
          }
        }
      }

      if (winner && winner !== playerA && winner !== playerB) {
        // record but keep it; downstream scripts can skip
        winnerNotAorB++;
      }

      matches.push({
        matchId: matchId ? Number(matchId) : null, // keep numeric if possible
        // NOTE: for Shape B, the indexed id in topics[1] is tournamentId.
        // We preserve it here for later debugging.
        indexedId: topics[1] ? Number(BigInt(topics[1])) : null,
        playerA,
        playerB,
        resultCode,
        winner,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
        logIndex: log.index,
      });
    }

    process.stdout.write(`\rmatch blocks ${start}..${end} logs=${logs.length} matchLogs=${matchLogs} winnersFound=${winnersFound}   `);
  }
  process.stdout.write("\n");

  const out = {
    updatedAtUtc: new Date().toISOString(),
    diamond: DIAMOND,
    rpc: RPC_URL,
    matchTopic0: MATCH_TOPIC0,
    hintTopic0: HINT_TOPIC0,
    startBlock: fromBlock,
    endBlock: toBlock,
    lookbackBlocks: LOOKBACK,
    chunkBlocks: CHUNK,
    matchLogs,
    hintLogs,
    hintFlag1Logs,
    winnersMapped: winnersByMatchId.size,
    winnersFound,
    winnersFoundById,
    winnersFoundByTx,
    winnerNotAorB,
    matches,
  };

  fs.mkdirSync(path.dirname(OUTFILE), { recursive: true });
  fs.writeFileSync(OUTFILE, JSON.stringify(out, null, 2));
  console.log("wrote", OUTFILE);
  console.log(
    `matchLogs=${matchLogs} hintLogs=${hintLogs} hintFlag1Logs=${hintFlag1Logs} winnersFound=${winnersFound} winnersFoundById=${winnersFoundById} winnersFoundByTx=${winnersFoundByTx} winner_not_AorB=${winnerNotAorB}`
  );

  const example = matches.find((m) => m.winner);
  console.log("example winner row:", example || null);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
