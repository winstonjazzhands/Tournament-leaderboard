import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const DIAMOND = (process.env.TOURNAMENT_DIAMOND ||
  "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const provider = new ethers.JsonRpcProvider(RPC_URL);

function short(x) {
  return x ? `${x.slice(0, 10)}…${x.slice(-8)}` : "";
}

// 4byte directory resolver (event sigs)
async function resolveTopic0(topic0) {
  try {
    const url = `https://www.4byte.directory/api/v1/event-signatures/?hex_signature=${topic0}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const first = json?.results?.[0]?.text_signature;
    return first || null;
  } catch {
    return null;
  }
}

async function main() {
  const latest = await provider.getBlockNumber();

  const lookback = Number(process.env.LOOKBACK_BLOCKS || 300000);
  const chunk = Number(process.env.CHUNK || 5000);
  const topN = Number(process.env.TOP_N || 80);
  const doResolve = (process.env.RESOLVE ?? "1") !== "0";

  const start = Math.max(0, latest - lookback);

  console.log("diamond:", DIAMOND);
  console.log("latest:", latest);
  console.log("scan:", `${start} -> ${latest} (lookback=${lookback}, chunk=${chunk})`);

  // topic0 -> { count, samples:Set(txHash) }
  const map = new Map();

  for (let from = start; from <= latest; from += chunk + 1) {
    const to = Math.min(latest, from + chunk);

    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: from,
      toBlock: to,
    });

    for (const log of logs) {
      const t0 = log.topics?.[0];
      if (!t0) continue;

      let entry = map.get(t0);
      if (!entry) entry = { count: 0, samples: new Set() };
      entry.count++;

      if (entry.samples.size < 3) entry.samples.add(log.transactionHash);
      map.set(t0, entry);
    }

    process.stdout.write(`\rblocks ${from}..${to}  logs=${logs.length}     `);
  }
  process.stdout.write("\n\n");

  const sorted = [...map.entries()].sort((a, b) => b[1].count - a[1].count);
  console.log(`Found ${sorted.length} unique topic0 event hashes\n`);

  for (let i = 0; i < Math.min(topN, sorted.length); i++) {
    const [topic0, info] = sorted[i];
    const samples = [...info.samples].map(short).join(", ");

    let sig = null;
    if (doResolve) sig = await resolveTopic0(topic0);

    console.log(
      `${String(i + 1).padStart(2, " ")}  ${topic0}  count=${String(info.count).padStart(7, " ")}  samples=[${samples}]`
    );
    if (sig) console.log(`    ↳ ${sig}`);
  }

  console.log("\nWhat we want: an event that includes TWO player addresses (A,B) and a winner / result, plus tournamentId.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});