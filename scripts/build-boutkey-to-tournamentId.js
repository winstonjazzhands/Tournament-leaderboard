// scripts/build-boutkey-to-tournamentId.js
//
// Builds mapping:
//   boutKey -> tournamentId (<= 9999)
//
// Discovered from vote tx receipts:
//   topic0 = 0x212d381b01f1e26324135ac9efbe6e1506536df18f511a42fba4c58f7d7af280
//   boutKey is data word index 1
//   tournamentId is data word index 2
//
// Defaults (your chosen test range):
//   fromBlock = 22000000
//   toBlock   = 22320000
//
// Usage:
//   set RPC_URL=https://andromeda.metis.io/?owner=1088
//   node scripts/build-boutkey-to-tournamentId.js
//   node scripts/build-boutkey-to-tournamentId.js 22000000 22320000
//
// Output:
//   public/boutToTournament.json

import fs from "fs";
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// Discovered mapping event
const BOUT_TOPIC0 =
  "0x212d381b01f1e26324135ac9efbe6e1506536df18f511a42fba4c58f7d7af280";

// Default test range (locked in)
const DEFAULT_FROM = 22000000;
const DEFAULT_TO = 22320000;

// Locked word indexes in log.data
const BOUTKEY_WORD = 1;     // data word index for boutKey
const TOURNAMENT_WORD = 2;  // data word index for tournamentId

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) {
    const chunk = data.slice(i, i + 64);
    if (chunk.length === 64) words.push("0x" + chunk);
  }
  return words;
}

const u = (hex) => BigInt(hex);

async function main() {
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL first.");

  const argFrom = process.argv[2] != null ? Number(process.argv[2]) : null;
  const argTo = process.argv[3] != null ? Number(process.argv[3]) : null;

  const fromBlock = Number.isFinite(argFrom) ? argFrom : DEFAULT_FROM;
  const toBlock = Number.isFinite(argTo) ? argTo : DEFAULT_TO;

  if (!Number.isFinite(fromBlock) || !Number.isFinite(toBlock) || toBlock < fromBlock) {
    throw new Error(
      "Usage: node scripts/build-boutkey-to-tournamentId.js [fromBlock toBlock]\n" +
      `Defaults: ${DEFAULT_FROM} ${DEFAULT_TO}`
    );
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  console.log("Scanning bout mapping logs:", fromBlock, "->", toBlock);

  const logs = await provider.getLogs({
    address: DIAMOND,
    fromBlock,
    toBlock,
    topics: [BOUT_TOPIC0],
  });

  console.log("Found mapping logs:", logs.length);
  if (!logs.length) {
    console.log("No mapping logs found in this range.");
    return;
  }

  const map = {};
  let keptRows = 0;
  let skipped = 0;

  for (const l of logs) {
    const words = splitWords(l.data);
    const boutHex = words[BOUTKEY_WORD];
    const tidHex = words[TOURNAMENT_WORD];

    if (!boutHex || !tidHex) { skipped++; continue; }

    const boutKey = u(boutHex).toString();
    const tidNum = Number(u(tidHex));

    if (!Number.isFinite(tidNum) || tidNum < 0 || tidNum > 9999) { skipped++; continue; }

    map[boutKey] = String(tidNum);
    keptRows++;
  }

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync("public/boutToTournament.json", JSON.stringify(map, null, 2));

  console.log("Wrote public/boutToTournament.json");
  console.log("Mapped entries:", Object.keys(map).length, "from", keptRows, "rows (skipped", skipped, ")");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
