// scripts/build-boutmeta.js
//
// Build bout metadata for Vote Watcher by scanning on-chain logs.
//
// Outputs:
//   public/boutMeta.json            (boutKey -> { uiTournamentId, tournamentId, fightIndex })
//   public/boutToTournament.json    (boutKey -> tournamentId)  [best-effort]
//   public/boutToUiTournament.json  (boutKey -> uiTournamentId) [authoritative for UI]
//
// Usage:
//   set RPC_URL=...
//   node scripts/build-boutmeta.js <fromBlock> <toBlock> [chunkSize]
//
// Optional override (skip discovery):
//   set BOUTMAP_TOPIC0=0x...   (topic0 for the bout-mapping event)

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

function splitWords(data) {
  const hex = (data || "").startsWith("0x") ? data.slice(2) : (data || "");
  const out = [];
  for (let i = 0; i < hex.length; i += 64) {
    out.push("0x" + hex.slice(i, i + 64).padEnd(64, "0"));
  }
  return out;
}
function u(word) {
  return ethers.toBigInt(word || "0x0");
}
function tryReadJson(path) {
  try { return JSON.parse(fs.readFileSync(path, "utf8")); } catch { return null; }
}
function isTopic0(x) {
  return typeof x === "string" && /^0x[0-9a-fA-F]{64}$/.test(x);
}

async function getLogsChunked(provider, baseFilter, fromBlock, toBlock, chunkSize = 2000) {
  const out = [];
  for (let start = fromBlock; start <= toBlock; start += chunkSize) {
    const end = Math.min(start + chunkSize - 1, toBlock);
    try {
      const part = await provider.getLogs({ ...baseFilter, fromBlock: start, toBlock: end });
      out.push(...part);
    } catch (e) {
      // If RPC chokes, retry smaller
      if (chunkSize > 250) {
        const smaller = Math.max(250, Math.floor(chunkSize / 2));
        console.warn(`getLogs failed for ${start}..${end}; retrying with chunk=${smaller}`);
        const part = await getLogsChunked(provider, baseFilter, start, end, smaller);
        out.push(...part);
      } else {
        throw e;
      }
    }
  }
  return out;
}

function buildBoutSetFromLedger(max = 8000) {
  const ledger = tryReadJson("public/votes-ledger.json") || [];
  const set = new Set();
  for (const r of ledger) {
    const bk = r?.w1 ?? r?.boutKey;
    if (bk == null) continue;
    const s = String(bk);
    if (s !== "0") set.add(s);
    if (set.size >= max) break;
  }
  return set;
}

function scoreTopic0Sample(sampleLogs, boutSet) {
  const maxWords = 12;
  let bestUi = { idx: -1, hits: 0 };
  let bestFight = { idx: -1, hits: 0 };
  let bestBout = { idx: -1, overlap: 0 };

  for (let wi = 0; wi < maxWords; wi++) {
    let uiHits = 0;
    let fightHits = 0;
    let overlap = 0;
    const seen = new Set();

    for (const l of sampleLogs) {
      const words = splitWords(l.data);
      if (wi >= words.length) continue;
      const n = Number(u(words[wi]));
      if (n >= 1500 && n <= 3000) uiHits++;
      if (n >= 0 && n <= 6) fightHits++;

      const s = String(n);
      if (boutSet.has(s) && !seen.has(s)) {
        seen.add(s);
        overlap++;
      }
    }

    if (uiHits > bestUi.hits) bestUi = { idx: wi, hits: uiHits };
    if (fightHits > bestFight.hits) bestFight = { idx: wi, hits: fightHits };
    if (overlap > bestBout.overlap) bestBout = { idx: wi, overlap };
  }

  return { bestUi, bestFight, bestBout };
}

function pickBestWordIdxByHits(sampleLogs, predicate, maxWords = 12) {
  let best = { idx: -1, hits: 0 };
  for (let wi = 0; wi < maxWords; wi++) {
    let hits = 0;
    for (const l of sampleLogs) {
      const words = splitWords(l.data);
      if (wi >= words.length) continue;
      const n = Number(u(words[wi]));
      if (predicate(n)) hits++;
    }
    if (hits > best.hits) best = { idx: wi, hits };
  }
  return best;
}

function pickBoutKeyWordIdx(sampleLogs, boutSet, maxWords = 12) {
  let best = { idx: -1, overlapUnique: 0 };
  for (let wi = 0; wi < maxWords; wi++) {
    const seen = new Set();
    for (const l of sampleLogs) {
      const words = splitWords(l.data);
      if (wi >= words.length) continue;
      const n = Number(u(words[wi]));
      const s = String(n);
      if (boutSet.has(s)) seen.add(s);
    }
    if (seen.size > best.overlapUnique) best = { idx: wi, overlapUnique: seen.size };
  }
  return best;
}

// best-effort internal tournamentId word: pick a word with very low unique count but not 0/1 enums
function pickInternalTournamentWord(sampleLogs, maxWords = 12) {
  let best = { idx: -1, uniq: Infinity };
  for (let wi = 0; wi < maxWords; wi++) {
    const set = new Set();
    let nonZero = 0;
    for (const l of sampleLogs) {
      const words = splitWords(l.data);
      if (wi >= words.length) continue;
      const n = Number(u(words[wi]));
      if (n !== 0) nonZero++;
      set.add(n);
      if (set.size > 50) break;
    }
    if (nonZero < 10) continue;
    // prefer small-ish unique counts, but avoid pure enums (<=10 unique) if they look like rounds/fightIndex
    if (set.size < best.uniq) best = { idx: wi, uniq: set.size };
  }
  return best;
}

async function main() {
  const rpc = process.env.RPC_URL;
  if (!rpc) throw new Error("Set RPC_URL first.");
  const provider = new ethers.JsonRpcProvider(rpc);

  const fromBlock = Number(process.argv[2] || "22000000");
  const toBlock = Number(process.argv[3] || "22320000");
  const chunkArg = process.argv[4] != null ? Number(process.argv[4]) : null;
  const chunkSize = Number.isFinite(chunkArg) && chunkArg > 0 ? Math.floor(chunkArg) : 2000;

  console.log(`Scanning bout mapping logs: ${fromBlock} -> ${toBlock}`);

  const boutSet = buildBoutSetFromLedger();

  const forced = process.env.BOUTMAP_TOPIC0;
  let mappingTopic0 = null;

  if (isTopic0(forced)) {
    mappingTopic0 = forced.toLowerCase();
    console.log("Using mapping topic0 override (BOUTMAP_TOPIC0):", mappingTopic0);
  } else {
    // First pass: gather topic0 counts + small samples per topic0 without pulling everything into memory
    const topicCounts = new Map();
    const topicSamples = new Map(); // topic0 -> logs[]

    for (let start = fromBlock; start <= toBlock; start += chunkSize) {
      const end = Math.min(start + chunkSize - 1, toBlock);
      const logs = await provider.getLogs({ address: DIAMOND, fromBlock: start, toBlock: end });
      for (const l of logs) {
        const t0 = (l.topics?.[0] || "").toLowerCase();
        if (!isTopic0(t0)) continue;
        topicCounts.set(t0, (topicCounts.get(t0) || 0) + 1);
        const arr = topicSamples.get(t0) || [];
        if (arr.length < 400) arr.push(l);
        topicSamples.set(t0, arr);
      }
    }

    // Score the top N by count
    const top = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30);
    let best = null;

    for (const [t0, cnt] of top) {
      const sample = topicSamples.get(t0) || [];
      if (sample.length < 50) continue;

      const { bestUi, bestFight, bestBout } = scoreTopic0Sample(sample, boutSet);

      // Hard filters: must look like it contains fightIndex 0..6 AND UI tid range AND decent overlap
      if (bestFight.hits < 80) continue;
      if (bestUi.hits < 80) continue;
      if (bestBout.overlap < 20) continue;

      const score = bestBout.overlap * 100 + bestUi.hits * 5 + bestFight.hits * 2 + Math.min(cnt, 50000) / 200;
      const row = { t0, cnt, score, bestUi, bestFight, bestBout };

      if (!best || row.score > best.score) best = row;
    }

    if (!best) {
      console.log("Could not confidently discover mapping topic0. Top topic0s by count:");
      console.table(top.map(([t0, cnt]) => ({ topic0: t0, logs: cnt })));
      throw new Error("Discovery failed. Set BOUTMAP_TOPIC0 manually to test a candidate.");
    }

    mappingTopic0 = best.t0;
    console.log("Discovered mapping topic0:", mappingTopic0);
    console.log(`UI tournament word index candidate: w${best.bestUi.idx} (uiHits=${best.bestUi.hits}, sample=${(topicSamples.get(mappingTopic0)||[]).length})`);
  }

  // Second pass: fetch mapping logs for chosen topic0
  const mappingLogs = await getLogsChunked(
    provider,
    { address: DIAMOND, topics: [mappingTopic0] },
    fromBlock,
    toBlock,
    chunkSize
  );

  console.log("Found mapping logs:", mappingLogs.length);

  const sample = mappingLogs.slice(0, 500);

  const ui = pickBestWordIdxByHits(sample, (n) => n >= 1500 && n <= 3000);
  const fight = pickBestWordIdxByHits(sample, (n) => n >= 0 && n <= 6);
  const bout = pickBoutKeyWordIdx(sample, boutSet);

  // We keep internal tournamentId as best-effort (may be useless / enum-like)
  const internalTid = pickInternalTournamentWord(sample);

  console.log(`UI tournament word index: ${ui.idx} (uiHits=${ui.hits}, sample=${sample.length})`);
  console.log(`Fight index word index: ${fight.idx} (hits0to6=${fight.hits}, sample=${sample.length})`);
  console.log(`BoutKey word index: ${bout.idx} (overlapUnique=${bout.overlapUnique}, sample=${sample.length})`);
  console.log(`Internal tournament word index (best-effort): ${internalTid.idx} (uniq≈${internalTid.uniq})`);

  if (ui.idx < 0 || fight.idx < 0 || bout.idx < 0) {
    throw new Error("Could not infer required word indexes (ui/fight/bout).");
  }

  const boutMeta = {};
  const boutToTournament = {};
  const boutToUiTournament = {};

  for (const l of mappingLogs) {
    const words = splitWords(l.data);
    if (bout.idx >= words.length || ui.idx >= words.length || fight.idx >= words.length) continue;

    const boutKey = u(words[bout.idx]).toString();
    const uiTidNum = Number(u(words[ui.idx]));
    const fightIdxNum = Number(u(words[fight.idx]));

    if (!(uiTidNum >= 1500 && uiTidNum <= 3000)) continue;
    if (!(fightIdxNum >= 0 && fightIdxNum <= 6)) continue;

    const uiTournamentId = String(uiTidNum);

    // best-effort internal tid
    let tournamentId = null;
    if (internalTid.idx >= 0 && internalTid.idx < words.length) {
      const t = Number(u(words[internalTid.idx]));
      if (Number.isFinite(t) && t !== 0) tournamentId = String(t);
    }

    if (!boutMeta[boutKey]) {
      boutMeta[boutKey] = {
        uiTournamentId,
        tournamentId,
        fightIndex: fightIdxNum
      };
    }

    if (tournamentId) boutToTournament[boutKey] = tournamentId;
    boutToUiTournament[boutKey] = uiTournamentId;
  }

  fs.writeFileSync("public/boutMeta.json", JSON.stringify(boutMeta, null, 2));
  fs.writeFileSync("public/boutToTournament.json", JSON.stringify(boutToTournament, null, 2));
  fs.writeFileSync("public/boutToUiTournament.json", JSON.stringify(boutToUiTournament, null, 2));

  console.log("Wrote public/boutMeta.json");
  console.log("Wrote public/boutToTournament.json");
  console.log("Wrote public/boutToUiTournament.json");
  console.log("Unique bouts:", Object.keys(boutMeta).length);
  console.log("Unique tournaments (internal):", new Set(Object.values(boutToTournament)).size);
  console.log("Unique UI tournaments:", new Set(Object.values(boutToUiTournament)).size);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
