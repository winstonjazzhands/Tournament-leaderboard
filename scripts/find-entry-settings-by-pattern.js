/**
 * scripts/find-entry-settings-by-pattern.js
 *
 * Pattern-based selector scan:
 * - Gets real tournamentIds from your subgraph (so IDs are valid)
 * - Calls every diamond selector with abi.encode(uint256 tournamentId)
 * - Scans return words for values near 10/20 (9/10/11/19/20/21)
 *
 * Run:
 *   node scripts/find-entry-settings-by-pattern.js
 */

import { ethers } from "ethers";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const LOUPE_ABI = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
  "function facetAddress(bytes4 selector) view returns (address)",
];

async function gql(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json?.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors)}`);
  return json.data;
}

function u256Calldata(selectorHex, tournamentId) {
  const sel = selectorHex.startsWith("0x") ? selectorHex.slice(2) : selectorHex;
  const arg = ethers.zeroPadValue(ethers.toBeHex(BigInt(tournamentId)), 32).slice(2);
  return "0x" + sel + arg;
}

function splitWords(ret, maxWords = 12) {
  if (!ret || ret === "0x") return [];
  const hex = ret.startsWith("0x") ? ret.slice(2) : ret;
  const words = [];
  for (let i = 0; i < Math.min(maxWords, Math.floor(hex.length / 64)); i++) {
    const w = "0x" + hex.slice(i * 64, i * 64 + 64);
    try {
      const bi = BigInt(w);
      // Only keep small-ish values as numbers; otherwise null to avoid overflow
      const n = bi <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bi) : null;
      words.push(n);
    } catch {
      words.push(null);
    }
  }
  return words;
}

function scoreWords(words) {
  // We want something that looks like level caps.
  // Strong signal: a 10/20-ish number exists at all.
  const targets = new Set([9, 10, 11, 19, 20, 21]);
  let hits = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    if (v !== null && targets.has(v)) hits.push({ i, v });
  }
  if (!hits.length) return null;

  // bonus if there are TWO plausible level-ish numbers
  // bonus if there is also a small min level (0..25) near it
  let score = 10 * hits.length;

  for (const h of hits) {
    // look around for min-like number 0..25
    for (let j = Math.max(0, h.i - 2); j <= Math.min(words.length - 1, h.i + 2); j++) {
      const v = words[j];
      if (v !== null && v >= 0 && v <= 25) score += 2;
    }
  }

  return { score, hits };
}

async function getSomeTournamentIds() {
  // Pull a handful of tournament IDs that definitely exist
  const data = await gql(`
    query {
      tournamentWins(first: 25, orderBy: timestamp, orderDirection: desc) {
        tournamentId
      }
    }
  `);

  const ids = (data?.tournamentWins || [])
    .map((w) => w.tournamentId)
    .filter((x) => x !== null && x !== undefined)
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n));

  // Unique, keep first few
  const uniq = [...new Set(ids)];
  return uniq.slice(0, 5);
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  const testIds = await getSomeTournamentIds();
  if (!testIds.length) {
    console.log("No tournamentIds returned from subgraph — cannot test.");
    return;
  }

  console.log("Diamond:", DIAMOND);
  console.log("RPC:", RPC_URL);
  console.log("Using tournamentIds from subgraph:", testIds.join(", "));

  const facets = await loupe.facets();
  const selectors = [];
  for (const f of facets) {
    for (const sel of f.functionSelectors) {
      selectors.push({ facet: f.facetAddress, selector: sel });
    }
  }
  console.log("Total selectors:", selectors.length);

  // Use only the first test id for the initial scan (faster)
  const tid = testIds[0];
  console.log("Scanning with tournamentId:", tid);

  const matches = [];

  for (let i = 0; i < selectors.length; i++) {
    const { facet, selector } = selectors[i];
    const data = u256Calldata(selector, tid);

    let ret;
    try {
      ret = await provider.call({ to: DIAMOND, data });
    } catch {
      continue;
    }

    const words = splitWords(ret, 12);
    if (words.length < 2) continue;

    const scored = scoreWords(words);
    if (!scored) continue;

    matches.push({
      selector,
      facet,
      score: scored.score,
      hits: scored.hits,
      words,
    });
  }

  matches.sort((a, b) => b.score - a.score);

  if (!matches.length) {
    console.log("\nNo pattern matches found (no 10/20-ish values in first 12 words).");
    console.log("Next step would be to scan more words (like 32) or try multi-arg calldata patterns.");
    return;
  }

  console.log(`\nTop ${Math.min(15, matches.length)} candidates:`);
  for (const m of matches.slice(0, 15)) {
    console.log("\n---");
    console.log("selector:", m.selector);
    console.log("facet:", m.facet);
    console.log("score:", m.score);
    console.log("hits:", m.hits.map((h) => `word[${h.i}]=${h.v}`).join(", "));
    console.log("first12words:", m.words.map((v, idx) => `${idx}:${v}`).join("  "));
  }

  // Validate best candidate against additional ids
  const best = matches[0];
  console.log("\n=== Validate BEST against other tournamentIds ===");
  for (const id of testIds.slice(0, 5)) {
    const data = u256Calldata(best.selector, id);
    try {
      const ret = await provider.call({ to: DIAMOND, data });
      const words = splitWords(ret, 12);
      const scored = scoreWords(words);
      console.log(`tournamentId ${id}: hits=${scored ? scored.hits.map(h=>`[${h.i}]=${h.v}`).join(",") : "none"} words=${words.map((v, idx)=>`${idx}:${v}`).join(" ")}`);
    } catch (e) {
      console.log(`tournamentId ${id}: call failed:`, e.shortMessage || e.message);
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});