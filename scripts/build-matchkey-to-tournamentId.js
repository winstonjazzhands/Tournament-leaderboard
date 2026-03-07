// scripts/build-matchkey-to-tournamentId.js
//
// Scans "match created" logs and builds a mapping of:
//   matchKey -> tournamentId (<= 9999)
//
// Defaults (your chosen test range):
//   fromBlock = 22000000
//   toBlock   = 22320000
//
// Locked decoding (stable for the default range you validated):
//   tournamentId word index = 0
//   matchKey      word index = 3
//
// You can still override:
//   - block range via CLI args
//   - word indexes via env vars (MATCH_TOURNAMENT_WORD, MATCH_KEY_WORD)
//   - or set INFER=1 to re-run heuristic inference
//
// Usage (CMD):
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/build-matchkey-to-tournamentId.js
//   node scripts/build-matchkey-to-tournamentId.js 22000000 22320000
//
// Optional overrides:
//   set MATCH_TOURNAMENT_WORD=0
//   set MATCH_KEY_WORD=3
//   set INFER=1
//
// Output:
//   public/matchToTournament.json

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// MatchCreated topic0 (from your earlier extraction)
const MATCH_TOPIC0 =
  "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

// Default test range (locked in)
const DEFAULT_FROM = 22000000;
const DEFAULT_TO = 22320000;

// Locked decoding indexes (stable for default range)
const LOCKED_TOURNAMENT_WORD = 0;
const LOCKED_MATCHKEY_WORD = 3;

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push("0x" + data.slice(i, i + 64));
  return words;
}

const u = (hex) => BigInt(hex);

function parseIntEnv(name) {
  const v = process.env[name];
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function inferTournamentWord(rows) {
  // Find which word is frequently <= 9999 but not constant
  const maxWords = Math.max(...rows.map(r => r.words.length));
  let best = { idx: null, score: -Infinity };

  for (let i = 0; i < maxWords; i++) {
    const vals = rows
      .map(r => (r.words[i] ? Number(u(r.words[i])) : null))
      .filter(v => v != null);

    if (!vals.length) continue;

    const uniq = new Set(vals).size;
    const max = Math.max(...vals);
    const min = Math.min(...vals);

    // TournamentId expectation: 0..9999, non-constant, decent uniqueness
    let score = 0;
    if (max <= 9999 && min >= 0) score += 100;
    if (uniq > 5) score += Math.min(200, uniq * 2);
    if (uniq === 1) score -= 500;

    // avoid fields that look like huge ids / addresses
    if (max > 5_000_000) score -= 200;

    if (score > best.score) best = { idx: i, score };
  }

  return best.idx;
}

function inferMatchKeyWord(rows, tournamentIdx) {
  // Find a word that varies a lot (many uniques) and isn't tournamentId.
  const maxWords = Math.max(...rows.map(r => r.words.length));
  let best = { idx: null, score: -Infinity };

  for (let i = 0; i < maxWords; i++) {
    if (i === tournamentIdx) continue;

    const vals = rows
      .map(r => (r.words[i] ? u(r.words[i]).toString() : null))
      .filter(v => v != null);

    if (!vals.length) continue;

    const uniq = new Set(vals).size;
    const score = uniq; // simple: more unique = more match-like

    if (score > best.score) best = { idx: i, score };
  }

  return best.idx;
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL first.");

  // CLI override for blocks, otherwise defaults
  const argFrom = process.argv[2] != null ? Number(process.argv[2]) : null;
  const argTo = process.argv[3] != null ? Number(process.argv[3]) : null;

  const fromBlock = Number.isFinite(argFrom) ? argFrom : DEFAULT_FROM;
  const toBlock = Number.isFinite(argTo) ? argTo : DEFAULT_TO;

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) {
    throw new Error(
      "Usage: node scripts/build-matchkey-to-tournamentId.js [fromBlock toBlock]\n" +
      `Defaults: ${DEFAULT_FROM} ${DEFAULT_TO}`
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log("Scanning match logs:", fromBlock, "->", toBlock);

  const logs = await provider.getLogs({
    address: DIAMOND,
    fromBlock,
    toBlock,
    topics: [MATCH_TOPIC0],
  });

  console.log("Found match logs:", logs.length);
  if (!logs.length) {
    console.log("No match logs found in this range.");
    return;
  }

  const decoded = logs.map(l => ({ txHash: l.transactionHash, words: splitWords(l.data) }));

  const forceInfer = process.env.INFER === "1" || process.env.INFER === "true";

  // Word index selection priority:
  // 1) env overrides (MATCH_TOURNAMENT_WORD / MATCH_KEY_WORD)
  // 2) locked defaults (0 / 3)
  // 3) heuristic inference (only if INFER=1)
  let tIdx = parseIntEnv("MATCH_TOURNAMENT_WORD");
  let mIdx = parseIntEnv("MATCH_KEY_WORD");

  if (tIdx == null) tIdx = LOCKED_TOURNAMENT_WORD;
  if (mIdx == null) mIdx = LOCKED_MATCHKEY_WORD;

  if (forceInfer) {
    const ti = inferTournamentWord(decoded);
    const mi = inferMatchKeyWord(decoded, ti);
    if (ti != null && mi != null) {
      tIdx = ti;
      mIdx = mi;
    }
  }

  console.log("Using word indexes:");
  console.log("  tournament word index:", tIdx, forceInfer ? "(infer enabled)" : "(locked/env)");
  console.log("  matchKey  word index :", mIdx, forceInfer ? "(infer enabled)" : "(locked/env)");

  const map = {};
  let keptRows = 0;
  let badRows = 0;

  for (const r of decoded) {
    const tHex = r.words[tIdx];
    const mHex = r.words[mIdx];
    if (!tHex || !mHex) { badRows++; continue; }

    const tidNum = Number(u(tHex));
    if (!Number.isFinite(tidNum) || tidNum < 0 || tidNum > 9999) { badRows++; continue; }

    const mk = u(mHex).toString();
    map[mk] = String(tidNum);
    keptRows++;
  }

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/matchToTournament.json", JSON.stringify(map, null, 2));

  console.log("Wrote public/matchToTournament.json");
  console.log("Mapped entries:", Object.keys(map).length, "from", keptRows, "rows (skipped", badRows, ")");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
