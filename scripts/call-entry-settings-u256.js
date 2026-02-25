#!/usr/bin/env node
"use strict";

const { ethers } = require("ethers");

// ====== EDIT THESE 2 LINES ONLY ======
const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B"; // address your UI is reading
// Optional but IMPORTANT if the function depends on msg.sender:
const FROM = "0xbA42e89b2f69C68E79898ba73D9A4Eb13D25c70e"; // <-- replace with your wallet if zeros
// =====================================

// EXACT signature you requested:
const ABI = [
  "function getTournamentEntrySettings(uint256 tournamentId) view returns (uint256 minLevel, uint256 maxLevel)"
];

function getArg(name) {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

async function main() {
  const idStr = getArg("id");
  if (!idStr) {
    console.error("Usage: node scripts/call-entry-settings-u256.js --id=1944");
    process.exit(1);
  }

  const provider = new ethers.JsonRpcProvider(RPC);
  const iface = new ethers.Interface(ABI);

  const data = iface.encodeFunctionData("getTournamentEntrySettings", [idStr]);
  const selector = data.slice(0, 10);

  console.log("RPC      :", RPC);
  console.log("Contract :", CONTRACT);
  console.log("From     :", FROM);
  console.log("Id       :", idStr);
  console.log("Selector :", selector, "(should be 0x4685cc3d if this signature matches)");
  console.log("Calldata :", data);

  const raw = await provider.call({
    to: CONTRACT,
    from: FROM, // try wallet address if you keep getting zeros
    data
  });

  console.log("Return bytes:", (raw.length - 2) / 2);
  console.log("Raw return  :", raw);

  const [minLevel, maxLevel] = iface.decodeFunctionResult("getTournamentEntrySettings", raw);
  console.log("Decoded min:", minLevel.toString());
  console.log("Decoded max:", maxLevel.toString());
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});