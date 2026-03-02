// scripts/inspect-topic0-log.js
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const provider = new ethers.JsonRpcProvider(RPC_URL);

const TOPIC0 = process.argv[2]?.toLowerCase();
const TX = process.argv[3]?.toLowerCase();

if (!TOPIC0 || TOPIC0.length !== 66 || !TX || TX.length !== 66) {
  throw new Error("Usage: node scripts/inspect-topic0-log.js 0x<topic0> 0x<txHash>");
}

function splitWords(data) {
  if (!data || data === "0x") return [];
  const hex = data.slice(2);
  const out = [];
  for (let i = 0; i < hex.length; i += 64) out.push("0x" + hex.slice(i, i + 64));
  return out;
}

function asUint(word) {
  try { return BigInt(word); } catch { return null; }
}

function maybeAddrFromWord(word) {
  // if it's left-padded address
  const hex = word.slice(2);
  if (hex.slice(0,24) !== "0".repeat(24)) return null;
  const tail = hex.slice(24);
  if (tail === "0".repeat(40)) return null;
  return "0x" + tail;
}

function maybeAddrFromTopic(topic) {
  const hex = topic.slice(2);
  if (hex.slice(0,24) !== "0".repeat(24)) return null;
  const tail = hex.slice(24);
  if (tail === "0".repeat(40)) return null;
  return "0x" + tail;
}

async function main() {
  const receipt = await provider.getTransactionReceipt(TX);
  if (!receipt) throw new Error("No receipt");

  const logs = receipt.logs.filter(l => (l.topics?.[0] || "").toLowerCase() === TOPIC0);

  console.log("tx:", TX);
  console.log("matched logs:", logs.length);
  console.log("");

  logs.slice(0, 6).forEach((log, idx) => {
    console.log(`--- log #${idx}  receiptIndex=${log.index}  block=${receipt.blockNumber} ---`);
    console.log("address:", log.address);
    console.log("topics:", log.topics.length);
    log.topics.forEach((t,i) => {
      const a = maybeAddrFromTopic(t);
      console.log(`  t[${i}]=${t}${a ? `  (asAddr ${a})` : ""}`);
    });

    const words = splitWords(log.data);
    console.log("data bytes:", (log.data.length - 2) / 2, "words:", words.length);

    words.slice(0, 12).forEach((w,i) => {
      const u = asUint(w);
      const a = maybeAddrFromWord(w);
      const small = (u !== null && u <= 1000000n) ? `  uint=${u}` : "";
      console.log(`  w[${i}]=${w}${a ? `  (asAddr ${a})` : ""}${small}`);
    });

    console.log("");
  });
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});