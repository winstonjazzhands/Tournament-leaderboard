// scripts/discover-boutkey-mapping-event.js
//
// Looks through vote transaction receipts and finds which log contains the vote boutKey (w1).
// Also tries to spot a likely tournamentId word (<= 9999) in that same log.
//
// Usage:
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/discover-boutkey-mapping-event.js
//
// Output:
//   Prints candidate topic0 and where the boutKey appears (topic index or data word index)

import fs from "fs";
import { ethers } from "ethers";

function splitWords(dataHex) {
  const data = dataHex?.startsWith("0x") ? dataHex.slice(2) : (dataHex || "");
  const words = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) words.push("0x" + chunk);
  }
  return words;
}

function toWordHexFromDecString(decStr) {
  // Convert decimal string -> 32-byte hex word (0x...)
  const bi = BigInt(decStr);
  return "0x" + bi.toString(16).padStart(64, "0");
}

function isLikelyTournamentIdWord(wordHex) {
  try {
    const n = Number(BigInt(wordHex));
    return Number.isFinite(n) && n >= 0 && n <= 9999;
  } catch {
    return false;
  }
}

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL first.");

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const ledger = JSON.parse(fs.readFileSync("public/votes-ledger.json", "utf8"));

  // Sample up to N unique nonzero vote rows
  const N = Number(process.env.SAMPLE || 25);
  const seenTx = new Set();
  const samples = [];

  for (const r of ledger) {
    const amt = BigInt(String(r.amount ?? "0"));
    if (amt <= 0n) continue;

    const boutKey = r.w1 != null ? String(r.w1) : null;
    const txHash = r.txHash || r.transactionHash;
    if (!boutKey || !txHash) continue;

    if (seenTx.has(txHash)) continue;
    seenTx.add(txHash);

    samples.push({ txHash, boutKey });
    if (samples.length >= N) break;
  }

  console.log("Sampling vote tx receipts:", samples.length);

  // Count hits per (topic0, location)
  // location examples: "topic1", "topic2", "topic3", "data:w5"
  const hitCounter = new Map();

  for (const s of samples) {
    const receipt = await provider.getTransactionReceipt(s.txHash);
    const targetWord = toWordHexFromDecString(s.boutKey);

    for (const log of receipt.logs) {
      const topic0 = log.topics?.[0];
      if (!topic0) continue;

      // Check topics 1..3 for exact match (indexed params)
      for (let ti = 1; ti <= 3; ti++) {
        if (log.topics?.[ti]?.toLowerCase() === targetWord.toLowerCase()) {
          const k = `${topic0}|topic${ti}`;
          hitCounter.set(k, (hitCounter.get(k) || 0) + 1);
        }
      }

      // Check data words for exact match
      const words = splitWords(log.data).map(w => w.toLowerCase());
      const idx = words.indexOf(targetWord.toLowerCase());
      if (idx !== -1) {
        const k = `${topic0}|data:w${idx}`;
        hitCounter.set(k, (hitCounter.get(k) || 0) + 1);

        // Also print tournamentId candidates in this same log (first time only)
        // (Helpful to immediately lock mapping word indexes)
      }
    }
  }

  const ranked = [...hitCounter.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  console.log("\nTop boutKey hit locations (topic0|where => hits):");
  for (const [k, v] of ranked) console.log(k, "=>", v);

  if (!ranked.length) {
    console.log("\nNo log contained the boutKey word in the sampled txs.");
    console.log("That would be unusual; increase SAMPLE or confirm votes-ledger has correct w1 + txHash.");
    return;
  }

  // For the best candidate, do a deeper single-tx print to help identify tournamentId word index.
  const [bestKey] = ranked[0];
  const [bestTopic0, bestWhere] = bestKey.split("|");
  console.log("\nBest candidate:", bestTopic0, bestWhere);

  const one = samples[0];
  const receipt = await provider.getTransactionReceipt(one.txHash);
  const targetWord = toWordHexFromDecString(one.boutKey).toLowerCase();

  console.log("\nExample tx:", one.txHash, "boutKey(w1):", one.boutKey);

  for (const log of receipt.logs) {
    if ((log.topics?.[0] || "").toLowerCase() !== bestTopic0.toLowerCase()) continue;

    const words = splitWords(log.data);
    const dataIdx = words.map(w => w.toLowerCase()).indexOf(targetWord);

    console.log("\n--- Matching log ---");
    console.log("emitter:", log.address);
    console.log("topic0:", log.topics[0]);
    console.log("topics:", log.topics.slice(1, 4));

    if (dataIdx !== -1) console.log("boutKey appears in data word index:", dataIdx);

    // print any likely tournamentId words in this log
    const tidCandidates = [];
    for (let i = 0; i < Math.min(words.length, 12); i++) {
      if (isLikelyTournamentIdWord(words[i])) {
        tidCandidates.push({ idx: i, val: Number(BigInt(words[i])) });
      }
    }
    console.log("tournamentId candidates (<=9999) in first 12 data words:", tidCandidates);
  }
}

main().catch(e => { console.error(e); process.exit(1); });