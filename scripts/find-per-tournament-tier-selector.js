/**
 * scripts/find-per-tournament-tier-selector.js
 *
 * Finds selectors that appear to return PER-TOURNAMENT settings keyed by tournamentId.
 * We look for:
 *  - return data changes across different tournamentIds
 *  - contains values near 10/20 somewhere in first N words
 *
 * Run:
 *   node scripts/find-per-tournament-tier-selector.js
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

async function getTournamentIds(n = 6) {
  const data = await gql(`
    query {
      tournamentWins(first: 50, orderBy: timestamp, orderDirection: desc) {
        tournamentId
      }
    }
  `);

  const ids = (data?.tournamentWins || [])
    .map((w) => w.tournamentId)
    .filter((x) => x !== null && x !== undefined)
    .map((x) => Number(x))
    .filter((v) => Number.isFinite(v));

  return [...new Set(ids)].slice(0, n);
}

function u256Calldata(selectorHex, tournamentId) {
  const sel = selectorHex.startsWith("0x") ? selectorHex.slice(2) : selectorHex;
  const arg = ethers.zeroPadValue(ethers.toBeHex(BigInt(tournamentId)), 32).slice(2);
  return "0x" + sel + arg;
}

function splitWords(ret, maxWords = 24) {
  if (!ret || ret === "0x") return [];
  const hex = ret.startsWith("0x") ? ret.slice(2) : ret;
  const words = [];
  const count = Math.min(maxWords, Math.floor(hex.length / 64));
  for (let i = 0; i < count; i++) {
    const w = "0x" + hex.slice(i * 64, i * 64 + 64);
    try {
      const bi = BigInt(w);
      const n = bi <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bi) : null;
      words.push(n);
    } catch {
      words.push(null);
    }
  }
  return words;
}

function hasLevelish(words) {
  const targets = new Set([9, 10, 11, 19, 20, 21]);
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    if (v !== null && targets.has(v)) return true;
  }
  return false;
}

function diffScore(wordsA, wordsB) {
  // score how different the two word arrays are (ignoring nulls)
  let diff = 0;
  const n = Math.min(wordsA.length, wordsB.length);
  for (let i = 0; i < n; i++) {
    const a = wordsA[i], b = wordsB[i];
    if (a === null || b === null) continue;
    if (a !== b) diff++;
  }
  return diff;
}

function summarizeHits(words) {
  const targets = new Set([9, 10, 11, 19, 20, 21]);
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    if (v !== null && targets.has(v)) hits.push(`[${i}]=${v}`);
  }
  return hits.join(",");
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  const ids = await getTournamentIds(6);
  if (ids.length < 2) {
    console.log("Not enough tournamentIds from subgraph to compare.");
    return;
  }

  console.log("Diamond:", DIAMOND);
  console.log("RPC:", RPC_URL);
  console.log("Tournament IDs:", ids.join(", "));

  const facets = await loupe.facets();
  const selectors = [];
  for (const f of facets) {
    for (const sel of f.functionSelectors) {
      selectors.push({ facet: f.facetAddress, selector: sel });
    }
  }
  console.log("Total selectors:", selectors.length);

  const idA = ids[0];
  const idB = ids[1];
  console.log("Comparing IDs:", idA, "vs", idB);

  const matches = [];

  for (const { facet, selector } of selectors) {
    // call with idA
    let retA;
    try {
      retA = await provider.call({ to: DIAMOND, data: u256Calldata(selector, idA) });
    } catch {
      continue;
    }
    const wA = splitWords(retA, 24);
    if (wA.length < 2) continue;

    // call with idB
    let retB;
    try {
      retB = await provider.call({ to: DIAMOND, data: u256Calldata(selector, idB) });
    } catch {
      continue;
    }
    const wB = splitWords(retB, 24);
    if (wB.length < 2) continue;

    // must contain some level-ish values and must differ across ids
    if (!hasLevelish(wA) && !hasLevelish(wB)) continue;

    const d = diffScore(wA, wB);
    if (d === 0) continue; // constant => not per tournament

    // extra: validate against more ids to ensure it changes sometimes
    let variability = 0;
    for (let k = 2; k < Math.min(ids.length, 6); k++) {
      try {
        const retK = await provider.call({ to: DIAMOND, data: u256Calldata(selector, ids[k]) });
        const wK = splitWords(retK, 24);
        if (diffScore(wA, wK) > 0) variability++;
      } catch {}
    }

    matches.push({
      selector,
      facet,
      diff: d,
      variability,
      hitsA: summarizeHits(wA),
      hitsB: summarizeHits(wB),
      wordsA: wA,
      wordsB: wB,
    });
  }

  matches.sort((a, b) => (b.variability - a.variability) || (b.diff - a.diff));

  if (!matches.length) {
    console.log("\nNo per-tournament candidates found with the 1-arg uint256(tournamentId) pattern.");
    console.log("Next step would be trying multi-arg patterns (2 args) or bytes32 keys.");
    return;
  }

  console.log(`\nTop ${Math.min(10, matches.length)} per-tournament candidates:`);
  for (const m of matches.slice(0, 10)) {
    console.log("\n---");
    console.log("selector:", m.selector);
    console.log("facet:", m.facet);
    console.log("diffWordsCount:", m.diff, "variability:", m.variability);
    console.log(`id ${idA} hits: ${m.hitsA || "(none)"}`);
    console.log(`id ${idB} hits: ${m.hitsB || "(none)"}`);
    console.log(`id ${idA} words0-23:`, m.wordsA.map((v, i) => `${i}:${v}`).join("  "));
    console.log(`id ${idB} words0-23:`, m.wordsB.map((v, i) => `${i}:${v}`).join("  "));
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});