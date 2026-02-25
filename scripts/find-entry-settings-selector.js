/**
 * scripts/find-entry-settings-selector.js
 *
 * Brute-force scan diamond selectors to find the function that returns
 * tournament entry min/max levels when called with (uint256 tournamentId).
 *
 * It calls: diamond.call( selector + abi.encode(uint256 tournamentId) )
 * and checks if return data looks like (minLevel, maxLevel, ...)
 *
 * Run:
 *   node scripts/find-entry-settings-selector.js
 */

import { ethers } from "ethers";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// Use these to validate against your known expectations
const TEST_IDS = [1944, 2072];

const LOUPE_ABI = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
  "function facetAddress(bytes4 selector) view returns (address)",
];

function u256Calldata(selectorHex, tournamentId) {
  // selectorHex like "0x12345678"
  const sel = selectorHex.startsWith("0x") ? selectorHex.slice(2) : selectorHex;
  const arg = ethers.zeroPadValue(ethers.toBeHex(BigInt(tournamentId)), 32).slice(2);
  return "0x" + sel + arg;
}

function decodeFirstTwoU256(ret) {
  if (!ret || ret === "0x") return null;
  // need at least 64 bytes => 128 hex chars after 0x
  if (ret.length < 2 + 64 + 64) return null;
  try {
    const a = BigInt(ret.slice(0, 2 + 64));
    const b = BigInt("0x" + ret.slice(2 + 64, 2 + 64 + 64));
    return { min: Number(a), max: Number(b) };
  } catch {
    return null;
  }
}

function plausibleMinMax(mm) {
  if (!mm) return false;
  const { min, max } = mm;
  if (!Number.isFinite(min) || !Number.isFinite(max)) return false;
  if (min < 0 || max < 0) return false;
  if (max > 200) return false; // sanity cap
  if (min > max) return false;
  // We expect something around 10/20 for maxLevel (or close)
  if (!(max === 10 || max === 20 || max === 9 || max === 11 || max === 19 || max === 21)) return false;
  return true;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  console.log("Diamond:", DIAMOND);
  console.log("RPC:", RPC_URL);
  console.log("Testing tournament IDs:", TEST_IDS.join(", "));

  const facets = await loupe.facets();

  // Flatten selectors with facet address
  const candidates = [];
  for (const f of facets) {
    for (const sel of f.functionSelectors) {
      candidates.push({ facet: f.facetAddress, selector: sel });
    }
  }
  console.log("Total selectors to test:", candidates.length);

  let found = 0;

  for (let i = 0; i < candidates.length; i++) {
    const { facet, selector } = candidates[i];
    const selectorHex = selector; // already 0x....
    // Call with first test id
    const data = u256Calldata(selectorHex, TEST_IDS[0]);

    let ret;
    try {
      ret = await provider.call({ to: DIAMOND, data });
    } catch {
      continue;
    }

    const mm = decodeFirstTwoU256(ret);
    if (!plausibleMinMax(mm)) continue;

    // If it looks plausible, test with the second ID too
    const data2 = u256Calldata(selectorHex, TEST_IDS[1]);
    let ret2;
    try {
      ret2 = await provider.call({ to: DIAMOND, data: data2 });
    } catch {
      continue;
    }
    const mm2 = decodeFirstTwoU256(ret2);
    if (!plausibleMinMax(mm2)) continue;

    found++;
    console.log("\n=== MATCH ===");
    console.log("selector:", selectorHex);
    console.log("facet (from facets()):", facet);

    // Also ask loupe which facet owns it (should agree)
    try {
      const ownerFacet = await loupe.facetAddress(selectorHex);
      console.log("facet (loupe.facetAddress):", ownerFacet);
    } catch {}

    console.log(`tournament ${TEST_IDS[0]} => min=${mm.min} max=${mm.max}`);
    console.log(`tournament ${TEST_IDS[1]} => min=${mm2.min} max=${mm2.max}`);

    // Stop early if we find multiple; you can remove this if you want all matches
    if (found >= 5) {
      console.log("\nFound 5 matches, stopping early.");
      break;
    }
  }

  if (!found) {
    console.log("\nNo matching selectors found with the uint256(tournamentId) calling convention.");
    console.log("If the function uses a different argument type (uint32/uint16) we can scan those too.");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});