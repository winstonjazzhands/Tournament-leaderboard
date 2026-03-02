// scripts/find-tournament-bout-tx.js
import { JsonRpcProvider } from "ethers";

const RPC_URL = process.env.RPC_URL;
if (!RPC_URL) {
  console.error("Missing RPC_URL env var");
  process.exit(1);
}

const DIAMOND = (process.env.TOURNAMENT_DIAMOND || "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

const tournamentId = BigInt(process.argv[2] || "0");
const A = (process.argv[3] || "").toLowerCase();
const B = (process.argv[4] || "").toLowerCase();

if (!tournamentId || !A.startsWith("0x") || !B.startsWith("0x")) {
  console.log("Usage: node scripts/find-tournament-bout-tx.js <tournamentId> <walletA> <walletB> [fromBlock] [toBlock]");
  process.exit(1);
}

// helper: 32-byte topic for uint
function topicUint(n) {
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return "0x" + hex.padStart(64, "0");
}
// helper: 32-byte topic for address (left-padded)
function topicAddr(addr) {
  return "0x" + addr.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
// helper: extract addr from topic
function addrFromTopic(t) {
  return "0x" + t.slice(-40).toLowerCase();
}

const provider = new JsonRpcProvider(RPC_URL);

const FROM = Number(process.argv[5] || 0);     // set these when you run it
const TO   = Number(process.argv[6] || 0);

async function main() {
  const latest = await provider.getBlockNumber();
  const toBlock = TO || latest;
  const fromBlock = FROM || Math.max(0, toBlock - 300000); // default lookback 300k

  console.log("diamond:", DIAMOND);
  console.log("scan:", fromBlock, "->", toBlock, `(lookback=${toBlock - fromBlock})`);
  console.log("tournamentId:", tournamentId.toString());
  console.log("A:", A);
  console.log("B:", B);

  // We don't know topic0 yet, so we brute-force by:
  // 1) filter logs from the diamond in range
  // 2) keep only logs with 4 topics (topic0 + 3 indexed)
  // 3) topic1 matches tournamentId
  // 4) topics2/3 are the two addresses (either order)
  //
  // This is heavier than topic0 filtering but very reliable for discovery.

  const chunk = 5000;
  const wantT1 = topicUint(tournamentId);
  const wantA = topicAddr(A);
  const wantB = topicAddr(B);

  let found = [];

  for (let start = fromBlock; start <= toBlock; start += chunk) {
    const end = Math.min(toBlock, start + chunk - 1);

    const logs = await provider.getLogs({
      address: DIAMOND,
      fromBlock: start,
      toBlock: end,
    });

    for (const log of logs) {
      if (!log.topics || log.topics.length !== 4) continue;
      if (log.topics[1].toLowerCase() !== wantT1) continue;

      const t2 = log.topics[2].toLowerCase();
      const t3 = log.topics[3].toLowerCase();

      const match =
        (t2 === wantA && t3 === wantB) ||
        (t2 === wantB && t3 === wantA);

      if (!match) continue;

      found.push({
        topic0: log.topics[0],
        txHash: log.transactionHash,
        blockNumber: log.blockNumber,
        logIndex: log.index,
        a: addrFromTopic(log.topics[2]),
        b: addrFromTopic(log.topics[3]),
      });
    }

    if (found.length) break; // stop on first hit; remove if you want all
    process.stdout.write(`\rblocks ${start}..${end} logs=${logs.length} found=${found.length}   `);
  }

  console.log("\nfound:", found.length);
  console.log(found.slice(0, 10));

  if (found.length) {
    console.log("\nNext: inspect this tx’s receipt to see the winner hint/logs:");
    console.log(`node scripts/find-rc3-tx-and-dump.js  # or use your receipt dumper`);
    console.log(`node scripts/inspect-topic0-log.js ${found[0].topic0} ${found[0].txHash}`);
    console.log(`node scripts/inspect-topic0-log.js 0x9ed8f9aac14f45bbc703fe9922e91c5db62b94877aeb6384e861d8d8c75db032 ${found[0].txHash}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});