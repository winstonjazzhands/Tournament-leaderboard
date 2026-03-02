// scripts/rank-match-topic0.js
import { ethers } from "ethers";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) throw new Error("Missing RPC_URL env var");

const DIAMOND = (process.env.TOURNAMENT_DIAMOND ||
  "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const provider = new ethers.JsonRpcProvider(RPC_URL);

function looksLikeAddressTopic(topic) {
  // topic is 32 bytes hex; address is last 20 bytes, usually left padded with zeros
  if (!topic || typeof topic !== "string" || !topic.startsWith("0x") || topic.length !== 66) return false;
  const hex = topic.slice(2);
  const left = hex.slice(0, 24);   // first 12 bytes
  const right = hex.slice(24);     // last 20 bytes
  // typical indexed address topic: left pad zeros, right not all zeros
  return /^[0]{24}$/.test(left) && !/^[0]{40}$/.test(right);
}

function topicToMaybeAddress(topic) {
  if (!looksLikeAddressTopic(topic)) return null;
  return "0x" + topic.slice(26); // last 40 hex chars
}

async function main() {
  const latest = await provider.getBlockNumber();

  const lookback = Number(process.env.LOOKBACK_BLOCKS || 300000);
  const chunk = Number(process.env.CHUNK || 5000);
  const start = Math.max(0, latest - lookback);

  console.log("diamond:", DIAMOND);
  console.log("latest:", latest);
  console.log("scan:", `${start} -> ${latest} (lookback=${lookback}, chunk=${chunk})`);

  // topic0 -> stats
  const stats = new Map();
  // store one example log per topic0
  const example = new Map();

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

      let s = stats.get(t0);
      if (!s) {
        s = { total: 0, topicsLen4: 0, addr2and3: 0, addr1and2: 0, anyTwoAddrs: 0 };
        stats.set(t0, s);
      }
      s.total++;

      const tl = log.topics.length;
      if (tl === 4) s.topicsLen4++;

      const a1 = looksLikeAddressTopic(log.topics[1]);
      const a2 = looksLikeAddressTopic(log.topics[2]);
      const a3 = looksLikeAddressTopic(log.topics[3]);

      if (a2 && a3) s.addr2and3++;
      if (a1 && a2) s.addr1and2++;
      if ((a1 && a2) || (a1 && a3) || (a2 && a3)) s.anyTwoAddrs++;

      if (!example.has(t0)) example.set(t0, log);
    }

    process.stdout.write(`\rblocks ${from}..${to} logs=${logs.length}   `);
  }
  process.stdout.write("\n\n");

  const rows = [...stats.entries()].map(([topic0, s]) => {
    const pct = (n) => (s.total ? (100 * n / s.total) : 0);
    return {
      topic0,
      total: s.total,
      pctTopicsLen4: pct(s.topicsLen4),
      pctAddr2and3: pct(s.addr2and3),
      pctAnyTwoAddrs: pct(s.anyTwoAddrs),
      score: pct(s.addr2and3) * 2 + pct(s.anyTwoAddrs) + pct(s.topicsLen4) * 0.5,
      ex: example.get(topic0),
    };
  });

  rows.sort((a, b) => b.score - a.score);

  console.log("Top candidates (most match-like):\n");
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const r = rows[i];
    const ex = r.ex;
    const t = ex?.topics || [];
    const a2 = topicToMaybeAddress(t[2]);
    const a3 = topicToMaybeAddress(t[3]);
    console.log(
      `${String(i + 1).padStart(2, " ")} ${r.topic0}  total=${String(r.total).padStart(7, " ")}  ` +
      `len4=${r.pctTopicsLen4.toFixed(1)}%  addr(2,3)=${r.pctAddr2and3.toFixed(1)}%  any2addrs=${r.pctAnyTwoAddrs.toFixed(1)}%`
    );
    if (a2 || a3) console.log(`    example addr topics: a=${a2 || "—"}  b=${a3 || "—"}  tx=${ex.transactionHash}`);
  }

  console.log("\nPick the best-looking topic0 (usually near the top) and feed it into extract script next.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});