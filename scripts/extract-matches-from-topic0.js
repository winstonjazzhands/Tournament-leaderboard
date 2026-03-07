// scripts/extract-matches-from-topic0.js
import { ethers } from "ethers";
import fs from "fs";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const DIAMOND = (
  process.env.TOURNAMENT_DIAMOND ||
  "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B"
).toLowerCase();

const MATCH_TOPIC0 = process.argv[2]?.toLowerCase();
if (!MATCH_TOPIC0 || MATCH_TOPIC0.length !== 66) {
  throw new Error("Usage: node scripts/extract-matches-from-topic0.js 0x<match_topic0>");
}

const WINNER_HINT_TOPIC0 = (
  process.env.WINNER_HINT_TOPIC0 ||
  "0x9ed8f9aac14f45bbc703fe9922e91c5db62b94877aeb6384e861d8d8c75db032"
).toLowerCase();

const OUT = process.env.OUT || "public/matches.json";
const provider = new ethers.JsonRpcProvider(RPC_URL);

function topicToAddress(topic) {
  if (!topic || topic.length !== 66) return null;
  const hex = topic.slice(2);
  if (hex.slice(0, 24) !== "0".repeat(24)) return null;
  const tail = hex.slice(24);
  if (tail === "0".repeat(40)) return null;
  return ("0x" + tail).toLowerCase();
}

function wordToAddress(word) {
  if (!word || word.length !== 66) return null;
  const hex = word.slice(2);
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
  for (let i = 0; i < hex.length; i += 64) {
    out.push("0x" + hex.slice(i, i + 64));
  }
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

function normalizeAddress(addr) {
  return typeof addr === "string" ? addr.toLowerCase() : null;
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
      provider.getLogs({
        address: DIAMOND,
        fromBlock: from,
        toBlock: to,
        topics: [MATCH_TOPIC0],
      }),
      provider.getLogs({
        address: DIAMOND,
        fromBlock: from,
        toBlock: to,
        topics: [WINNER_HINT_TOPIC0],
      }),
    ]);

    matchLogs.push(...a);
    hintLogs.push(...b);

    process.stdout.write(
      `\rblocks ${from}..${to}  matchLogs=${matchLogs.length}  hintLogs=${hintLogs.length}   `
    );
  }
  process.stdout.write("\n");

  // Optional secondary source from the hint logs.
  // Based on the debug output, the hint layout appears to be:
  //   topic1 = resultCode
  //   topic2 = winner wallet
  //   data[0] = tournamentId / matchId
  //   data[1] = flag
  //
  // But the match logs themselves already contain the winner directly in data[1],
  // which is much more reliable for this extractor.
  const hintWinnerByMatchId = new Map();
  let hintAccepted = 0;

  for (const log of hintLogs) {
    const t = log.topics || [];
    const words = splitWords(log.data);

    const hintedResultCode = topicToUintBI(t[1]);
    const hintedWinner = topicToAddress(t[2]);
    const hintedMatchIdBI = words[0] ? topicToUintBI(words[0]) : null;
    const hintedFlag = words[1] ? wordToSmallInt(words[1]) : null;

    if (!hintedResultCode || !hintedWinner || !hintedMatchIdBI || hintedFlag == null) continue;
    if (hintedFlag !== 1) continue;

    hintAccepted++;
    const key = hintedMatchIdBI.toString();

    if (!hintWinnerByMatchId.has(key)) {
      hintWinnerByMatchId.set(key, new Set());
    }
    hintWinnerByMatchId.get(key).add(hintedWinner);
  }

  const matches = [];
  let winnersFound = 0;
  let winnersFromMatchData = 0;
  let winnersFromHintFallback = 0;
  let matchDataWinnerInvalid = 0;
  let hintFallbackInvalid = 0;
  let winnerSourceDisagreements = 0;

  for (const log of matchLogs) {
    const t = log.topics || [];
    const words = splitWords(log.data);

    const matchIdBI = topicToUintBI(t[1]);
    const matchId = matchIdBI !== null ? Number(matchIdBI) : null;

    const playerA = normalizeAddress(topicToAddress(t[2]));
    const playerB = normalizeAddress(topicToAddress(t[3]));

    const resultCode = words[0] ? wordToSmallInt(words[0]) : null;

    // This is the key fix:
    // the match log itself stores the winner in data word 1.
    const matchDataWinner = normalizeAddress(words[1] ? wordToAddress(words[1]) : null);

    let winner = null;
    let winnerSource = null;

    if (matchDataWinner && (matchDataWinner === playerA || matchDataWinner === playerB)) {
      winner = matchDataWinner;
      winnerSource = "matchDataWord1";
      winnersFromMatchData++;
    } else if (matchDataWinner) {
      matchDataWinnerInvalid++;
    }

    // Fallback to hint logs only if match data did not yield a valid winner.
    if (!winner && matchIdBI) {
      const candidateSet = hintWinnerByMatchId.get(matchIdBI.toString());
      if (candidateSet) {
        if (playerA && candidateSet.has(playerA)) {
          winner = playerA;
          winnerSource = "hintFallback";
          winnersFromHintFallback++;
        } else if (playerB && candidateSet.has(playerB)) {
          winner = playerB;
          winnerSource = "hintFallback";
          winnersFromHintFallback++;
        } else {
          hintFallbackInvalid++;
        }
      }
    }

    // Track disagreements where both sources exist and point to different valid players.
    if (matchIdBI) {
      const candidateSet = hintWinnerByMatchId.get(matchIdBI.toString());
      const hintWinner =
        candidateSet && playerA && candidateSet.has(playerA)
          ? playerA
          : candidateSet && playerB && candidateSet.has(playerB)
            ? playerB
            : null;

      if (
        matchDataWinner &&
        hintWinner &&
        matchDataWinner !== hintWinner &&
        (matchDataWinner === playerA || matchDataWinner === playerB)
      ) {
        winnerSourceDisagreements++;
      }
    }

    if (winner) winnersFound++;

    matches.push({
      matchId,
      playerA,
      playerB,
      resultCode,
      winner,
      winnerSource,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash,
      logIndex: log.index,
    });
  }

  const payload = {
    updatedAtUtc: new Date().toISOString(),
    diamond: DIAMOND,
    matchTopic0: MATCH_TOPIC0,
    winnerHintTopic0: WINNER_HINT_TOPIC0,
    lookbackBlocks: lookback,
    totalMatchLogs: matchLogs.length,
    totalHintLogs: hintLogs.length,
    hintAccepted,
    winnersFound,
    winnersFromMatchData,
    winnersFromHintFallback,
    matchDataWinnerInvalid,
    hintFallbackInvalid,
    winnerSourceDisagreements,
    decodingNotes: {
      matchLog: {
        topic1: "matchId",
        topic2: "playerA",
        topic3: "playerB",
        dataWord0: "resultCode",
        dataWord1: "winner wallet",
      },
      hintLog: {
        topic1: "resultCode",
        topic2: "winner wallet",
        dataWord0: "matchId",
        dataWord1: "flag",
      },
    },
    matches,
  };

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));

  console.log(`wrote ${OUT}`);
  console.log(
    `matchLogs=${matchLogs.length} hintLogs=${hintLogs.length} winnersFound=${winnersFound}`
  );
  console.log(
    `winnersFromMatchData=${winnersFromMatchData} winnersFromHintFallback=${winnersFromHintFallback}`
  );
  console.log(
    `matchDataWinnerInvalid=${matchDataWinnerInvalid} hintFallbackInvalid=${hintFallbackInvalid} winnerSourceDisagreements=${winnerSourceDisagreements}`
  );

  const ex = matches.find((x) => x.winner);
  console.log("example winner row:", ex || null);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
