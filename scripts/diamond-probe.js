/**
 * scripts/diamond-probe.js
 *
 * Goal:
 * - Prove whether the diamond supports loupe (facetAddresses/facets/facetFunctionSelectors)
 * - If it does, list facet addresses
 * - Optionally, try calling facetFunctionSelectors for a known facet address
 *
 * Run:
 *   node scripts/diamond-probe.js
 */

import { ethers } from "ethers";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const LOUPE_ABI = [
  "function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])",
  "function facetAddresses() view returns (address[])",
  "function facetFunctionSelectors(address facet) view returns (bytes4[])",
  "function facetAddress(bytes4 selector) view returns (address)",
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  const loupe = new ethers.Contract(DIAMOND, LOUPE_ABI, provider);

  console.log("Diamond:", DIAMOND);

  // 1) facetAddresses
  try {
    const addrs = await loupe.facetAddresses();
    console.log("facetAddresses() count:", addrs.length);
    console.log(addrs);
  } catch (e) {
    console.log("facetAddresses() FAILED:", e.shortMessage || e.message);
  }

  // 2) facets() (heavy but informative)
  try {
    const f = await loupe.facets();
    console.log("facets() count:", f.length);
    // Print just addresses + selector counts
    for (const entry of f) {
      console.log(entry.facetAddress, "selectors:", entry.functionSelectors.length);
    }
  } catch (e) {
    console.log("facets() FAILED:", e.shortMessage || e.message);
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});