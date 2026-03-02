import { ethers } from "ethers";
import fs from "fs";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const provider = new ethers.JsonRpcProvider(RPC_URL);

const matches = JSON.parse(fs.readFileSync("public/matches.json", "utf-8")).matches || [];

const pick = matches.find(m => m.resultCode === 3);
if (!pick) throw new Error("No resultCode=3 match found");

console.log("picked rc=3 match:", pick);

const receipt = await provider.getTransactionReceipt(pick.txHash);
console.log("\nreceipt logs:", receipt.logs.length, "block:", receipt.blockNumber);

function splitWords(data) {
  if (!data || data === "0x") return [];
  const hex = data.slice(2);
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push("0x" + hex.slice(i, i + 64));
  return out;
}
function asSmallInt(word) {
  try {
    const n = BigInt(word);
    if (n <= 1000000n) return Number(n);
    return null;
  } catch {
    return null;
  }
}

receipt.logs.slice(0, 80).forEach((log, i) => {
  const t0 = (log.topics?.[0] || "");
  console.log(`\n[${i}] addr=${log.address} idx=${log.index}`);
  console.log(`  topic0=${t0}`);
  console.log(`  topics=${log.topics.length}`);
  log.topics.slice(0, 4).forEach((t, j) => console.log(`    t[${j}]=${t}`));
  const words = splitWords(log.data);
  console.log(`  dataWords=${words.length}`);
  words.slice(0, 6).forEach((w, j) => {
    const si = asSmallInt(w);
    console.log(`    w[${j}]=${w}${si !== null ? ` (uint=${si})` : ""}`);
  });
});