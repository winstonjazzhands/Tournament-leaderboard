#!/usr/bin/env node
"use strict";

const { ethers } = require("ethers");

// --- CONFIG ---
const RPC = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const IDS = [
  { id: 1944n, expected: 20 },
  { id: 2072n, expected: 10 },
];

// Diamond Loupe ABI
const LOUPE_ABI = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
];

// Likely getters where config lives
const PROBE_FRAGMENTS = [
  // Common “tournament struct” patterns
  "function tournaments(uint256) view returns (uint256)",
  "function tournaments(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function tournaments(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function tournament(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function tournamentInfo(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournament(uint256) view returns (uint256)",
  "function getTournament(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournament(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getTournamentInfo(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournamentConfig(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournamentDetails(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",
  "function getTournamentSettings(uint256) view returns (uint256,uint256,uint256,uint256)",

  // Sometimes a direct maxLevel getter exists
  "function getTournamentMaxLevel(uint256) view returns (uint256)",
  "function maxLevel(uint256) view returns (uint256)",
  "function tournamentMaxLevel(uint256) view returns (uint256)",
];

function chunk32(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i < clean.length; i += 64) {
    out.push("0x" + clean.slice(i, i + 64).padEnd(64, "0"));
  }
  return out;
}

function anyNonZeroWord(hex) {
  const words = chunk32(hex);
  return words.some((w) => BigInt(w) !== 0n);
}

function find10or20(hex) {
  const words = chunk32(hex);
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const v = BigInt(words[i]);
    if (v === 10n || v === 20n) hits.push({ index: i, value: v.toString() });
  }
  return hits;
}

async function tryCall(provider, to, fragment, id) {
  const iface = new ethers.Interface([fragment]);
  const fn = Object.keys(iface.functions)[0];
  const data = iface.encodeFunctionData(fn, [id]);
  const raw = await provider.call({ to, data });
  return raw;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  const facets = await loupe.facets();

  console.log("Diamond:", DIAMOND);
  console.log("Facets :", facets.length);
  console.log("Probes :", PROBE_FRAGMENTS.length);
  console.log("");

  for (const f of facets) {
    const facetAddr = f.facetAddress;

    let printedFacetHeader = false;

    for (const t of IDS) {
      for (const frag of PROBE_FRAGMENTS) {
        try {
          const raw = await tryCall(provider, facetAddr, frag, t.id);

          if (!anyNonZeroWord(raw)) continue;

          const hits = find10or20(raw);
          if (!printedFacetHeader) {
            printedFacetHeader = true;
            console.log("======================================");
            console.log("FACET:", facetAddr);
            console.log("======================================");
          }

          console.log(
            `id=${t.id.toString()} expected=${t.expected} | ${frag} | bytes=${(raw.length - 2) / 2} | hits=${hits.length ? JSON.stringify(hits) : "none"}`
          );

          // If we hit 10/20, show first few words for context
          if (hits.length) {
            const words = chunk32(raw).slice(0, 10).map((w, i) => `[${i}]=${BigInt(w).toString()}`);
            console.log("  firstWords:", words.join(" "));
          }
        } catch (_) {
          // ignore
        }
      }
    }
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});