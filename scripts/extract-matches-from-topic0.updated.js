// scripts/extract-matches-from-topic0.js
// ESM script (repo uses "type": "module")
//
// Purpose:
//   - Extract tournament match rows from a "match" event topic0
//   - Optionally enrich each row with a winner address from a "winner hint" topic0
//
// Default assumptions (based on your Metis Tournament Diamond logs):
//   match event (topic0 = MATCH_TOPIC0) has topics:
//     [0] topic0
//     [1] id (often registry tournamentId; sometimes a matchId depending on event family)
//     [2] playerA (indexed address)
//     [3] playerB (indexed address)
//   match event data often starts with a uint resultCode in word0 (1..6), but we keep it optional.
//
//   winner hint event (topic0 = HINT_TOPIC0) has topics:
//     [0] topic0
//     [1] id (typically the same id used by *some* match events; not always registry tournamentId)
//     [2] winner (indexed address)   <-- THIS is the important part
//   hint event data may contain extra flags; we ignore them for winner extraction.
//
// Robustness:
//   - Primary join: by id (topics[1]) when available
//   - Fallback join: by txHash (if exactly one unique hint winner exists in that tx)
//
// Usage:
//   RPC_URL=... TOURNAMENT_DIAMOND=0x... node scripts/extract-matches-from-topic0.js <MATCH_TOPIC0> [HINT_TOPIC0] [lookbackBlocks] [chunkBlocks] [outFile]
//
// Examples:
//   node scripts/extract-matches-from-topic0.js 0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897
//   node scripts/extract-matches-from-topic0.js 0x2b93... 0x9ed8... 300000 5000 public/matches.json

import fs from "fs/promises";
import path from "path";
import process from "process";
import { JsonRpcProvider } from "ethers";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("❌ Missing RPC_URL (set env var RPC_URL)");
  process.exit(1);
}

const DIAMOND = (process.env.TOURNAMENT_DIAMOND ||
  "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const MATCH_TOPIC0 = (process.argv[2] || "").toLowerCase();
if (!MATCH_TOPIC0.startsWith("0x") || MATCH_TOPIC0.length !== 66) {
  console.error("Usage: node scripts/extract-matches-from-topic0.js <MATCH_TOPIC0> [HINT_TOPIC0] [lookbackBlocks] [chunkBlocks] [outFile]");
  console.error("Example MATCH_TOPIC0: 0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897");
  process.exit(1);
}

const DEFAULT_HINT = "0x9ed8f9aac14f45bbc703fe9922e91c5db62b94877aeb6384e861d8d8c75db032";
const HINT_TOPIC0 = (process.argv[3] || DEFAULT_HINT).toLowerCase();

const lookbackBlocks = Number(process.argv[4] || 300000);
const chunkBlocks = Number(process.argv[5] || 5000);
const outFileArg = process.argv[6] || "public/matches.json";

function isHex32Topic(x) {
  return typeof x === "string" && x.startsWith("0x") && x.length === 66;
}

function addrFromTopic(t) {
  // topic is 32 bytes; last 20 bytes are address
  return "0x" + t.slice(-40).toLowerCase();
}

function uintFromHexWord(wordHex) {
  if (!wordHex || typeof wordHex !== "string") return null;
  const h = wordHex.startsWith("0x") ? wordHex.slice(2) : wordHex;
  if (h.length === 0) return null;
  return BigInt("0x" + h);
}

function firstWordAsUint(dataHex) {
  if (!dataHex || dataHex === "0x") return null;
  const h = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  if (h.length < 64) return null;
  const word0 = h.slice(0, 64);
  return uintFromHexWord(word0);
}

function resolveOutPath(p) {
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const latest = await provider.getBlockNumber();
  const toBlock = latest;
  const fromBlock = Math.max(0, toBlock - lookbackBlocks);

  console.log("diamond:", DIAMOND);
  console.log("match topic0:", MATCH_TOPIC0);
  console.log("winner hint topic0:", HINT_TOPIC0);
  console.log("latest:", latest);
  console.log(`scan: ${fromBlock} -> ${toBlock} (lookback=${lookbackBlocks}, chunk=${chunkBlocks})`);

  // --- pass 1: scan hint logs ---
  const winnersById = new Map(); // id(string) -> winnerAddr
  const winnersByTx = new Map(); // txHash -> Set(winnerAddr)

  let hintLogs = 0;
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(toBlock, start + chunkBlocks - 1);

    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: start,
      toBlock: end,
      topics: [HINT_TOPIC0],
    });

    hintLogs += logs.length;

    for (const log of logs) {
      if (!log.topics || log.topics.length < 3) continue;
      if (!isHex32Topic(log.topics[1]) || !isHex32Topic(log.topics[2])) continue;

      const id = uintFromHexWord(log.topics[1]).toString();
      const winner = addrFromTopic(log.topics[2]);

      winnersById.set(id, winner);

      const tx = (log.transactionHash || "").toLowerCase();
      if (tx) {
        if (!winnersByTx.has(tx)) winnersByTx.set(tx, new Set());
        winnersByTx.get(tx).add(winner);
      }
    }

    if ((start - fromBlock) % (chunkBlocks * 10) === 0) {
      process.stdout.write(`\rhint blocks ${start}..${end} totalHintLogs=${hintLogs}   `);
    }
  }
  process.stdout.write("\n");

  // --- pass 2: scan match logs ---
  const matches = [];
  let matchLogs = 0;

  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(toBlock, start + chunkBlocks - 1);

    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: start,
      toBlock: end,
      topics: [MATCH_TOPIC0],
    });

    matchLogs += logs.length;

    for (const log of logs) {
      if (!log.topics || log.topics.length !== 4) continue;
      if (!isHex32Topic(log.topics[1]) || !isHex32Topic(log.topics[2]) || !isHex32Topic(log.topics[3])) continue;

      const id = uintFromHexWord(log.topics[1]).toString();
      const playerA = addrFromTopic(log.topics[2]);
      const playerB = addrFromTopic(log.topics[3]);

      const rc = firstWordAsUint(log.data);
      const resultCode = rc === null ? null : Number(rc);

      // winner resolution:
      // 1) id join
      let winner = winnersById.get(id) || null;

      // 2) tx fallback if id join misses
      if (!winner) {
        const tx = (log.transactionHash || "").toLowerCase();
        const set = tx ? winnersByTx.get(tx) : null;
        if (set && set.size === 1) winner = [...set][0];
      }

      matches.push({
        matchId: Number(id),          // may be large; still useful for quick grep
        matchIdStr: id,               // lossless id string
        playerA,
        playerB,
        resultCode,                   // may be null
        winner,                       // may be null if hint missing / ambiguous
        blockNumber: log.blockNumber,
        txHash: (log.transactionHash || "").toLowerCase(),
        logIndex: log.index,
      });
    }

    if ((start - fromBlock) % (chunkBlocks * 10) === 0) {
      process.stdout.write(`\rmatch blocks ${start}..${end} totalMatchLogs=${matchLogs} matches=${matches.length}   `);
    }
  }
  process.stdout.write("\n");

  // --- stats ---
  const winnersFound = matches.filter(m => m.winner).length;
  const winnerNotAorB = matches.filter(m => m.winner && m.winner !== m.playerA && m.winner !== m.playerB).length;

  console.log(`matchLogs=${matchLogs} hintLogs=${hintLogs} winnersFound=${winnersFound} winner_not_AorB=${winnerNotAorB}`);

  // --- write output ---
  const outPath = resolveOutPath(outFileArg);
  const payload = {
    updatedAtUtc: new Date().toISOString(),
    source: {
      rpc: RPC_URL,
      tournamentDiamond: DIAMOND,
      fromBlock,
      toBlock,
      lookbackBlocks,
      chunkBlocks,
      matchTopic0: MATCH_TOPIC0,
      hintTopic0: HINT_TOPIC0,
    },
    matches,
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");

  console.log("wrote", outPath, "matches:", matches.length);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
