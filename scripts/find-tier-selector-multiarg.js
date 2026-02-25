/**
 * scripts/find-tier-selector-multiarg.js
 *
 * Brute-force multi-arg selector scan to find per-tournament level cap (10 vs 20).
 *
 * It tests these calldata shapes:
 *  - (uint256 id, uint256 idx) idx in [0..3]
 *  - (uint256 id, address samplePlayer)
 *  - (bytes32 key) with key variants:
 *      bytes32(id), keccak256(abi.encode(id)), keccak256(abi.encodePacked(id))
 *  - (bytes32 key, uint256 idx) idx in [0..3]
 *
 * Hit criteria:
 *  - return words differ between two ids (so it’s per-tournament)
 *  - some word ~10 or ~20 appears (9/10/11/19/20/21) within first 32 words
 *
 * Run:
 *   node scripts/find-tier-selector-multiarg.js
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

async function getSampleData() {
  const data = await gql(`
    query {
      tournamentWins(first: 60, orderBy: timestamp, orderDirection: desc) {
        tournamentId
        player { id }
      }
    }
  `);

  const rows = data?.tournamentWins || [];
  const ids = [];
  let samplePlayer = null;

  for (const r of rows) {
    const tid = Number(r.tournamentId);
    if (Number.isFinite(tid)) ids.push(tid);

    const p = r?.player?.id;
    if (!samplePlayer && typeof p === "string" && p.startsWith("0x") && p.length === 42) {
      samplePlayer = p;
    }
  }

  const uniqIds = [...new Set(ids)].slice(0, 8);
  return { ids: uniqIds, samplePlayer };
}

function pad32(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}

function wordFromU256(n) {
  return pad32(ethers.toBeHex(BigInt(n)).slice(2));
}

function wordFromAddress(addr) {
  const a = addr.toLowerCase().replace(/^0x/, "");
  return a.padStart(64, "0");
}

function wordFromBytes32(hex32) {
  const h = hex32.toLowerCase().replace(/^0x/, "");
  if (h.length !== 64) throw new Error("bytes32 must be 32 bytes (64 hex chars)");
  return h;
}

function calldata(selector, words) {
  const sel = selector.startsWith("0x") ? selector.slice(2) : selector;
  return "0x" + sel + words.join("");
}

function bytes32FromId(id) {
  return "0x" + wordFromU256(id);
}

function keccakAbiEncodeId(id) {
  // keccak256(abi.encode(uint256 id))
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [BigInt(id)]);
  return ethers.keccak256(encoded);
}

function keccakPackedId(id) {
  // keccak256(abi.encodePacked(uint256 id))
  // Packed uint256 is 32 bytes big-endian, same as abi.encode for single uint256,
  // but keep it explicit:
  const word = "0x" + wordFromU256(id);
  return ethers.keccak256(word);
}

function splitWords(ret, maxWords = 32) {
  if (!ret || ret === "0x") return [];
  const hex = ret.startsWith("0x") ? ret.slice(2) : ret;
  const out = [];
  const count = Math.min(maxWords, Math.floor(hex.length / 64));
  for (let i = 0; i < count; i++) {
    const w = "0x" + hex.slice(i * 64, i * 64 + 64);
    try {
      const bi = BigInt(w);
      const n = bi <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bi) : null;
      out.push(n);
    } catch {
      out.push(null);
    }
  }
  return out;
}

function hasLevelish(words) {
  const targets = new Set([9, 10, 11, 19, 20, 21]);
  for (const v of words) if (v !== null && targets.has(v)) return true;
  return false;
}

function diffCount(a, b) {
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) {
    if (a[i] === null || b[i] === null) continue;
    if (a[i] !== b[i]) d++;
  }
  return d;
}

function hitsSummary(words) {
  const targets = new Set([9, 10, 11, 19, 20, 21]);
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const v = words[i];
    if (v !== null && targets.has(v)) hits.push(`[${i}]=${v}`);
  }
  return hits.join(",");
}

function fmtWords(words, limit = 16) {
  return words.slice(0, limit).map((v, i) => `${i}:${v}`).join("  ");
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  const { ids, samplePlayer } = await getSampleData();
  if (ids.length < 2) {
    console.log("Not enough tournament IDs from subgraph to compare.");
    return;
  }
  if (!samplePlayer) {
    console.log("Could not find a sample player address from subgraph.");
    return;
  }

  const idA = ids[0];
  const idB = ids[1];

  console.log("Diamond:", DIAMOND);
  console.log("RPC:", RPC_URL);
  console.log("Tournament IDs:", ids.join(", "));
  console.log("Compare IDs:", idA, "vs", idB);
  console.log("Sample player:", samplePlayer);

  const facets = await loupe.facets();
  const selectors = [];
  for (const f of facets) {
    for (const sel of f.functionSelectors) {
      selectors.push({ selector: sel, facet: f.facetAddress });
    }
  }
  console.log("Total selectors:", selectors.length);

  // Build test patterns (functions returning {name, makeCalldata(id)})
  const patterns = [];

  // (uint256 id, uint256 idx)
  for (const idx of [0, 1, 2, 3]) {
    patterns.push({
      name: `u256,u256 idx=${idx}`,
      make: (id) => calldata("SEL", [wordFromU256(id), wordFromU256(idx)]),
    });
  }

  // (uint256 id, address player)
  patterns.push({
    name: "u256,address samplePlayer",
    make: (id) => calldata("SEL", [wordFromU256(id), wordFromAddress(samplePlayer)]),
  });

  // (bytes32 key) variants
  const keyFns = [
    { label: "bytes32(id)", fn: (id) => bytes32FromId(id) },
    { label: "keccak256(abi.encode(id))", fn: (id) => keccakAbiEncodeId(id) },
    { label: "keccak256(abi.encodePacked(id))", fn: (id) => keccakPackedId(id) },
  ];

  for (const k of keyFns) {
    patterns.push({
      name: `bytes32 key=${k.label}`,
      make: (id) => {
        const key = k.fn(id);
        return calldata("SEL", [wordFromBytes32(key)]);
      },
    });
    for (const idx of [0, 1, 2, 3]) {
      patterns.push({
        name: `bytes32 key=${k.label}, u256 idx=${idx}`,
        make: (id) => {
          const key = k.fn(id);
          return calldata("SEL", [wordFromBytes32(key), wordFromU256(idx)]);
        },
      });
    }
  }

  function injectSelector(data, selector) {
    // Replace placeholder "SEL" with the actual selector bytes
    return data.replace(/^0xSEL/, "0x" + selector.replace(/^0x/, ""));
  }

  const hits = [];

  for (const { selector, facet } of selectors) {
    for (const pat of patterns) {
      const dataA = injectSelector(pat.make(idA), selector);
      const dataB = injectSelector(pat.make(idB), selector);

      let retA, retB;
      try {
        retA = await provider.call({ to: DIAMOND, data: dataA });
        retB = await provider.call({ to: DIAMOND, data: dataB });
      } catch {
        continue;
      }

      const wA = splitWords(retA, 32);
      const wB = splitWords(retB, 32);
      if (wA.length < 2 || wB.length < 2) continue;

      if (!hasLevelish(wA) && !hasLevelish(wB)) continue;

      const d = diffCount(wA, wB);
      if (d === 0) continue;

      // validate quickly against more ids
      let variability = 0;
      for (let i = 2; i < Math.min(ids.length, 6); i++) {
        const id = ids[i];
        const data = injectSelector(pat.make(id), selector);
        try {
          const ret = await provider.call({ to: DIAMOND, data });
          const w = splitWords(ret, 32);
          if (diffCount(wA, w) > 0) variability++;
        } catch {}
      }

      hits.push({
        selector,
        facet,
        pattern: pat.name,
        diff: d,
        variability,
        hitsA: hitsSummary(wA),
        hitsB: hitsSummary(wB),
        wordsA: wA,
        wordsB: wB,
      });
    }
  }

  hits.sort((a, b) => (b.variability - a.variability) || (b.diff - a.diff));

  if (!hits.length) {
    console.log("\nNo hits found in these multi-arg patterns.");
    console.log("If this happens, the settings may live in a different contract (not this diamond), or require different calldata.");
    return;
  }

  console.log(`\nTop ${Math.min(10, hits.length)} hits:`);
  for (const h of hits.slice(0, 10)) {
    console.log("\n---");
    console.log("selector:", h.selector);
    console.log("facet:", h.facet);
    console.log("pattern:", h.pattern);
    console.log("diffWordsCount:", h.diff, "variability:", h.variability);
    console.log(`id ${idA} level-hits: ${h.hitsA || "(none)"}`);
    console.log(`id ${idB} level-hits: ${h.hitsB || "(none)"}`);
    console.log(`id ${idA} words0-15:`, fmtWords(h.wordsA, 16));
    console.log(`id ${idB} words0-15:`, fmtWords(h.wordsB, 16));
  }

  console.log("\nPaste the top hit block back into chat and we’ll wire it into the tier puller.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});