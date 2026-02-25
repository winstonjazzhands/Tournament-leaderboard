// scripts/inspect-entry-settings.js
// Usage: node scripts/inspect-entry-settings.js 1944 2072
//
// 1) Calls DiamondLoupe facetAddress(bytes4) WITH from set
// 2) Calls getTournamentEntrySettings selector WITH from set on diamond
// 3) If we found a facet, calls selector on facet too
//
// Selector under test: 0x1a5bd7fc (the one you captured from your UI)

const { JsonRpcProvider } = require("ethers");

const RPC = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// IMPORTANT: must be set (match your UI / working wallet)
const FROM = "0x971bDACd04EF40141ddb6bA175d4f76665103c81";

const SELECTOR = "0x1a5bd7fc";          // getTournamentEntrySettings(?) selector from your UI
const LOUPE_FACETADDR = "0xcdffacc6";   // facetAddress(bytes4)

function pad32(hexNo0x) {
  return hexNo0x.padStart(64, "0");
}

function buildCalldata(selector4, tournamentId) {
  const idHex = BigInt(tournamentId).toString(16);
  return selector4 + pad32(idHex);
}

function chunk32(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i < clean.length; i += 64) out.push("0x" + clean.slice(i, i + 64));
  return out;
}

function summarizeWords(raw, maxWords = 24) {
  const words = chunk32(raw);
  const show = Math.min(maxWords, words.length);
  const lines = [];
  const nonZero = [];
  for (let i = 0; i < show; i++) {
    const v = BigInt(words[i]);
    lines.push(`[${i}] ${words[i]} => ${v.toString()}`);
    if (v !== 0n) nonZero.push({ i, v: v.toString() });
  }
  return { lines, nonZero };
}

function decodeFacetAddress(raw32) {
  // facetAddress returns address padded in 32 bytes (last 20 bytes)
  const clean = raw32.startsWith("0x") ? raw32.slice(2) : raw32;
  if (clean.length < 64) return null;
  return "0x" + clean.slice(24);
}

async function ethCall(provider, to, data) {
  // Always include from (critical)
  return provider.send("eth_call", [{ to, from: FROM, data }, "latest"]);
}

async function tryLoupeFacetAddress(provider) {
  // bytes4 goes in the low 4 bytes of the 32-byte slot
  const data = LOUPE_FACETADDR + pad32(SELECTOR.slice(2));
  try {
    const raw = await ethCall(provider, DIAMOND, data);
    const addr = decodeFacetAddress(raw);
    if (!addr) return null;
    if (addr.toLowerCase() === "0x0000000000000000000000000000000000000000") return null;
    return addr;
  } catch (e) {
    // Loupe may be blocked; don't crash
    return null;
  }
}

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(n => Number.isFinite(n));
  if (!ids.length) {
    console.log("Usage: node scripts/inspect-entry-settings.js <tournamentId> [moreIds...]");
    process.exit(1);
  }

  const provider = new JsonRpcProvider(RPC);

  console.log("RPC      :", RPC);
  console.log("DIAMOND   :", DIAMOND);
  console.log("FROM      :", FROM);
  console.log("SELECTOR  :", SELECTOR);

  const facetAddr = await tryLoupeFacetAddress(provider);
  console.log("Loupe facetAddress(selector) =>", facetAddr ? facetAddr : "(loupe blocked or selector not found)");

  for (const tid of ids) {
    console.log("\n==========================================");
    console.log(`Tournament ID: ${tid}`);

    const callData = buildCalldata(SELECTOR, tid);

    // Call diamond
    console.log("\n--- DIAMOND eth_call ---");
    console.log("to:", DIAMOND);
    console.log("data:", callData);

    try {
      const rawDiamond = await ethCall(provider, DIAMOND, callData);
      console.log("Return bytes:", (rawDiamond.length - 2) / 2);
      const sD = summarizeWords(rawDiamond, 24);
      console.log("First 24 words:");
      for (const line of sD.lines) console.log(line);
      console.log("Non-zero indexes:", sD.nonZero.length ? sD.nonZero : "none");
    } catch (e) {
      console.log("DIAMOND call reverted:", e.shortMessage || e.message || String(e));
    }

    // Call facet directly if we got one
    if (facetAddr) {
      console.log("\n--- FACET eth_call ---");
      console.log("to:", facetAddr);
      console.log("data:", callData);

      try {
        const rawFacet = await ethCall(provider, facetAddr, callData);
        console.log("Return bytes:", (rawFacet.length - 2) / 2);
        const sF = summarizeWords(rawFacet, 24);
        console.log("First 24 words:");
        for (const line of sF.lines) console.log(line);
        console.log("Non-zero indexes:", sF.nonZero.length ? sF.nonZero : "none");
      } catch (e) {
        console.log("FACET call reverted:", e.shortMessage || e.message || String(e));
      }
    }
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});