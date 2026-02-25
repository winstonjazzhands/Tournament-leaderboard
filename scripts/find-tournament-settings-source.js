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

// The function we *thought* was right:
const TARGET_SIG = "getTournamentEntrySettings(uint256)";
const TARGET_SELECTOR = ethers.id(TARGET_SIG).slice(0, 10); // 0x + 8 hex

// Diamond Loupe minimal ABI (many diamonds implement this)
const LOUPE_ABI = [
  "function facetAddress(bytes4 _functionSelector) view returns (address facetAddress)",
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
];

// We’ll try these getters too (common variations)
const PROBE_FRAGMENTS = [
  // Your getter
  "function getTournamentEntrySettings(uint256) view returns (uint256)",
  "function getTournamentEntrySettings(uint256) view returns (uint256,uint256)",
  "function getTournamentEntrySettings(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournamentEntrySettings(uint256) view returns (uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)",

  // Other likely getters
  "function getTournament(uint256) view returns (uint256)",
  "function getTournament(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function getTournamentInfo(uint256) view returns (uint256)",
  "function getTournamentInfo(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function tournamentEntrySettings(uint256) view returns (uint256,uint256)",
  "function tournaments(uint256) view returns (uint256,uint256,uint256,uint256)",
  "function tournamentConfig(uint256) view returns (uint256,uint256)",

  // Sometimes stored as a “maxLevel only”
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
  return { raw, fn };
}

async function probeAddress(provider, addr, label) {
  console.log("\n===============================");
  console.log("PROBING:", label, addr);
  console.log("===============================");

  for (const t of IDS) {
    console.log("\n--- tournamentId", t.id.toString(), "(expected max", t.expected + ") ---");

    // First: call the target selector directly (no ABI decode)
    try {
      const data = TARGET_SELECTOR + t.id.toString(16).padStart(64, "0");
      const raw = await provider.call({ to: addr, data });
      const hits = find10or20(raw);
      console.log("Direct selector call return bytes:", (raw.length - 2) / 2);
      console.log("Non-zero?", anyNonZeroWord(raw));
      console.log("10/20 hits:", hits.length ? hits : "none");
    } catch (e) {
      console.log("Direct selector call failed:", e.shortMessage || e.message || String(e));
    }

    // Second: try a bunch of likely getter fragments
    for (const frag of PROBE_FRAGMENTS) {
      try {
        const { raw } = await tryCall(provider, addr, frag, t.id);
        if (!anyNonZeroWord(raw)) continue; // skip noisy zero returns
        const hits = find10or20(raw);
        console.log("OK:", frag, "| bytes:", (raw.length - 2) / 2, "| hits:", hits.length ? hits : "none");
      } catch (_) {
        // ignore
      }
    }
  }
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  console.log("Diamond:", DIAMOND);
  console.log("Target function:", TARGET_SIG);
  console.log("Selector:", TARGET_SELECTOR);

  // 1) Probe the diamond itself
  await probeAddress(provider, DIAMOND, "DIAMOND");

  // 2) Try Diamond Loupe to find facet implementing selector
  let facet = null;
  try {
    const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);
    facet = await loupe.facetAddress(TARGET_SELECTOR);
    if (facet && facet !== ethers.ZeroAddress) {
      console.log("\nDiamond Loupe facetAddress(selector) =", facet);
      await probeAddress(provider, facet, "FACET (from Loupe)");
    } else {
      console.log("\nDiamond Loupe returned zero facet for selector (or not implemented).");
    }
  } catch (e) {
    console.log("\nDiamond Loupe not available / call failed:", e.shortMessage || e.message || String(e));
  }

  console.log("\nDone.");
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});