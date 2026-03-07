import { ethers } from "ethers";
import fs from "fs";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const DIAMOND = (process.env.TOURNAMENT_DIAMOND ||
  "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const MATCH_TOPIC0 = process.argv[2]?.toLowerCase();
if (!MATCH_TOPIC0 || MATCH_TOPIC0.length !== 66) {
  throw new Error("Usage: node scripts/debug-winner-hints.js 0x<match_topic0>");
}

const WINNER_HINT_TOPIC0 =
  (process.env.WINNER_HINT_TOPIC0 ||
   "0x9ed8f9aac14f45bbc703fe9922e91c5db62b94877aeb6384e861d8d8c75db032"
  ).toLowerCase();

const provider = new ethers.JsonRpcProvider(RPC_URL);

function topicToAddress(topic) {
  if (!topic || topic.length !== 66) return null;
  const hex = topic.slice(2);
  if (hex.slice(0, 24) !== "0".repeat(24)) return null;
  const tail = hex.slice(24);
  if (tail === "0".repeat(40)) return null;
  return ("0x" + tail).toLowerCase();
}

function topicToUintBI(topic) {
  try {
    if (!topic || topic.length !== 66) return null;
    const n = BigInt(topic);
    return n >= 0n ? n : null;
  } catch {
    return null;
  }
}

function splitWords(data) {
  if (!data || data === "0x") return [];
  const hex = data.slice(2);
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push("0x" + hex.slice(i, i + 64));
  return out;
}

function wordToSmallInt(word) {
  try {
    const n = BigInt(word);
    if (n <= 1000000n) return Number(n);
    return null;
  } catch {
    return null;
  }
}

function decodeLog(log) {
  const topics = log.topics || [];
  const words = splitWords(log.data);

  return {
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index,
    topics,
    topicAddresses: topics.map(topicToAddress),
    topicInts: topics.map((t) => {
      const n = topicToUintBI(t);
      if (n === null) return null;
      return n <= 1000000n ? Number(n) : n.toString();
    }),
    dataWords: words,
    dataWordInts: words.map(wordToSmallInt),
    dataWordAddresses: words.map(topicToAddress),
  };
}

async function main() {
  const latest = await provider.getBlockNumber();
  const lookback = Number(process.env.LOOKBACK_BLOCKS || 300000);
  const chunk = Number(process.env.CHUNK || 5000);
  const start = Math.max(0, latest - lookback);

  console.log("diamond:", DIAMOND);
  console.log("match topic0:", MATCH_TOPIC0);
  console.log("winner hint topic0:", WINNER_HINT_TOPIC0);
  console.log("scan:", `${start} -> ${latest}`);

  const matchLogs = [];
  const hintLogs = [];

  for (let from = start; from <= latest; from += chunk + 1) {
    const to = Math.min(latest, from + chunk);
    const [a, b] = await Promise.all([
      provider.getLogs({ address: DIAMOND, fromBlock: from, toBlock: to, topics: [MATCH_TOPIC0] }),
      provider.getLogs({ address: DIAMOND, fromBlock: from, toBlock: to, topics: [WINNER_HINT_TOPIC0] }),
    ]);
    matchLogs.push(...a);
    hintLogs.push(...b);
    process.stdout.write(`\rblocks ${from}..${to}  matchLogs=${matchLogs.length}  hintLogs=${hintLogs.length}   `);
  }
  process.stdout.write("\n");

  const out = {
    generatedAtUtc: new Date().toISOString(),
    diamond: DIAMOND,
    matchTopic0: MATCH_TOPIC0,
    winnerHintTopic0: WINNER_HINT_TOPIC0,
    lookbackBlocks: lookback,
    totalMatchLogs: matchLogs.length,
    totalHintLogs: hintLogs.length,
    sampleMatchLogs: matchLogs.slice(0, 20).map(decodeLog),
    sampleHintLogs: hintLogs.slice(0, 50).map(decodeLog),
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/hint-debug.json", JSON.stringify(out, null, 2));
  console.log("wrote public/hint-debug.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
