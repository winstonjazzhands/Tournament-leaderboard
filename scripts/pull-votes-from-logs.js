#!/usr/bin/env node
// scripts/pull-votes-from-logs.js
//
// Build Vote Watcher data from on-chain logs.
//
// Usage:
//   RPC_URL=... node scripts/pull-votes-from-logs.js <startBlock> <endBlock>
//
// Outputs (in ./public):
//   votes-ledger.json          (raw decoded words)
//   votes.json                 (clean rows: tournamentId, matchId, side, votes, voter, timestamp)
//   voteTotals.json            (totals per tournamentId + side)
//   votesByWallet.json         (totals per wallet + per tournament breakdown)
//
// Notes:
// - This indexes the EXISTING vote system.
// - Field mapping (tournamentId/matchId/side) is inferred from the data using
//   constraints you described:
//   * tournamentId should be <= 9999 ("4 digits or less")
//   * side should effectively be A/B (two values)
//   * votes amount is data word w5 (confirmed by earlier analysis)

import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const VOTE_CONTRACT = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";
const VOTE_TOPIC0 =
  "0x212d381b01f1e26324135ac9efbe6e1506536df18f511a42fba4c58f7d7af280";

const WORD_KEYS = ["w0", "w1", "w2", "w3", "w4", "w5"];

function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push("0x" + data.slice(i, i + 64));
  return words;
}

function topicToAddress(topic) {
  return ethers.getAddress("0x" + topic.slice(26));
}

function hexToU256Str(hex) {
  return BigInt(hex).toString();
}

function fmtInt(nStr) {
  try {
    return BigInt(nStr).toString();
  } catch {
    return "0";
  }
}

function isLikelyTwoSide(values) {
  // values are strings
  const s = new Set(values);
  if (s.size !== 2) return false;
  const nums = [...s].map((x) => Number(x)).sort((a, b) => a - b);
  // Accept common binary encodings
  return (
    (nums[0] === 0 && nums[1] === 1) ||
    (nums[0] === 1 && nums[1] === 2) ||
    (nums[0] === 1 && nums[1] === 0)
  );
}

function inferMapping(ledgerRows) {
  // ledgerRows have w0..w5 already as decimal strings
  const candidates = ["w0", "w1", "w2", "w3", "w4"];

  // TournamentId candidates: max <= 9999 and more than 1 unique
  const tournamentCandidates = candidates
    .map((k) => {
      const vals = ledgerRows.map((r) => r[k]).filter((v) => v != null);
      const uniq = new Set(vals);
      const max = Math.max(...[...uniq].map((x) => Number(x)));
      return { k, uniqCount: uniq.size, max };
    })
    .filter((x) => x.uniqCount >= 1 && x.max <= 9999)
    .sort((a, b) => b.uniqCount - a.uniqCount);

  // Side candidates: two-valued across rows (ignore zeros-only)
  const sideCandidates = candidates
    .map((k) => {
      const vals = ledgerRows
        .map((r) => r[k])
        .filter((v) => v != null && v !== "0");
      const uniq = [...new Set(vals)];
      return { k, uniq, uniqCount: uniq.length };
    })
    .filter((x) => x.uniqCount === 2 && isLikelyTwoSide(x.uniq));

  const tournamentKey = tournamentCandidates[0]?.k ?? null;
  const sideKey = sideCandidates[0]?.k ?? null;

  // Match candidate: prefer the most unique among remaining keys
  const remaining = candidates.filter((k) => k !== tournamentKey && k !== sideKey);
  const matchKey = remaining
    .map((k) => {
      const uniq = new Set(ledgerRows.map((r) => r[k]).filter((v) => v != null));
      return { k, uniqCount: uniq.size };
    })
    .sort((a, b) => b.uniqCount - a.uniqCount)[0]?.k;

  return { tournamentKey, matchKey, sideKey };
}

function buildAggregates(votesRows) {
  const voteTotals = {}; // voteTotals[tournamentId][side] = sum
  const votesByWallet = {}; // wallet -> totals + byTournament

  for (const v of votesRows) {
    const t = v.tournamentId;
    const s = v.side;
    const w = v.voter;
    const amt = BigInt(v.votes);

    voteTotals[t] ??= {};
    voteTotals[t][s] ??= "0";
    voteTotals[t][s] = (BigInt(voteTotals[t][s]) + amt).toString();

    votesByWallet[w] ??= { totalVotes: "0", byTournament: {} };
    votesByWallet[w].totalVotes = (BigInt(votesByWallet[w].totalVotes) + amt).toString();
    votesByWallet[w].byTournament[t] ??= { totalVotes: "0", bySide: {} };
    votesByWallet[w].byTournament[t].totalVotes =
      (BigInt(votesByWallet[w].byTournament[t].totalVotes) + amt).toString();
    votesByWallet[w].byTournament[t].bySide[s] ??= "0";
    votesByWallet[w].byTournament[t].bySide[s] =
      (BigInt(votesByWallet[w].byTournament[t].bySide[s]) + amt).toString();
  }

  return { voteTotals, votesByWallet };
}

async function main() {
  const rpcUrl = requireEnv("RPC_URL");
  const startBlock = Number(process.argv[2]);
  const endBlock = Number(process.argv[3]);
  if (!Number.isFinite(startBlock) || !Number.isFinite(endBlock) || endBlock < startBlock) {
    throw new Error("Usage: node scripts/pull-votes-from-logs.js <startBlock> <endBlock>");
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  console.log(`Scanning blocks: ${startBlock} -> ${endBlock}`);

  const logs = await provider.getLogs({
    address: VOTE_CONTRACT,
    fromBlock: startBlock,
    toBlock: endBlock,
    topics: [VOTE_TOPIC0],
  });

  console.log(`Found vote logs: ${logs.length}`);

  const tsCache = new Map();
  async function getTimestamp(blockNumber) {
    if (tsCache.has(blockNumber)) return tsCache.get(blockNumber);
    const b = await provider.getBlock(blockNumber);
    const ts = Number(b.timestamp);
    tsCache.set(blockNumber, ts);
    return ts;
  }

  // Build raw ledger
  const ledger = [];
  for (const log of logs) {
    const voter = topicToAddress(log.topics[1]);
    const words = splitWords(log.data);
    const ts = await getTimestamp(log.blockNumber);

    const row = {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      timestamp: ts,
      voter,
    };

    for (let i = 0; i < 6; i++) {
      const key = WORD_KEYS[i];
      row[key] = words[i] ? hexToU256Str(words[i]) : null;
    }

    // votes amount is w5
    row.amount = fmtInt(row.w5 ?? "0");
    ledger.push(row);
  }

  // Infer mapping for tournamentId/matchId/side
  const mapping = inferMapping(ledger);
  console.log("Inferred mapping:");
  console.log("  tournamentId =", mapping.tournamentKey);
  console.log("  matchId      =", mapping.matchKey);
  console.log("  side         =", mapping.sideKey);

  if (!mapping.tournamentKey || !mapping.sideKey) {
    console.log("WARNING: Could not confidently infer mapping (tournamentId/side). Writing ledger only.");
  }

  // Build clean votes rows, excluding anything without tournamentId (per your UI requirement)
  const votes = [];
  for (const r of ledger) {
    const tournamentId = mapping.tournamentKey ? r[mapping.tournamentKey] : null;
    const side = mapping.sideKey ? r[mapping.sideKey] : null;
    const matchId = mapping.matchKey ? r[mapping.matchKey] : null;
    const votesAmt = r.amount;

    if (!tournamentId) continue; // strict
    if (!side) continue;

    votes.push({
      tournamentId,
      matchId,
      side, // A/B encoded as 0/1 or 1/2 depending on contract
      votes: votesAmt,
      voter: r.voter,
      timestamp: r.timestamp,
      txHash: r.txHash,
      blockNumber: r.blockNumber,
    });
  }

  // Sort newest first
  votes.sort((a, b) => (b.timestamp - a.timestamp) || (b.blockNumber - a.blockNumber));

  const { voteTotals, votesByWallet } = buildAggregates(votes);

  const publicDir = path.join(process.cwd(), "public");
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "votes-ledger.json"), JSON.stringify(ledger, null, 2));
  fs.writeFileSync(path.join(publicDir, "votes.json"), JSON.stringify(votes, null, 2));
  fs.writeFileSync(path.join(publicDir, "voteTotals.json"), JSON.stringify(voteTotals, null, 2));
  fs.writeFileSync(path.join(publicDir, "votesByWallet.json"), JSON.stringify(votesByWallet, null, 2));

  console.log("Wrote public/votes-ledger.json");
  console.log("Wrote public/votes.json");
  console.log("Wrote public/voteTotals.json");
  console.log("Wrote public/votesByWallet.json");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
