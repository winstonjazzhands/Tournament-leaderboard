#!/usr/bin/env node
"use strict";

const { ethers } = require("ethers");

const RPC = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

// Pick one at a time if needed
const TARGETS = [
  { id: 1944n, expected: 20 },
  { id: 2072n, expected: 10 },
];

// Window: keep it smaller if it’s slow
const FROM_BLOCK = 20500000;
const TO_BLOCK = "latest";

function topicUint256(n) {
  return ethers.zeroPadValue(ethers.toBeHex(n), 32);
}

function bytesToWords(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const out = [];
  for (let i = 0; i < clean.length; i += 64) {
    out.push("0x" + clean.slice(i, i + 64).padEnd(64, "0"));
  }
  return out;
}

function scanWordHits(words, expected) {
  const hits = [];
  for (let i = 0; i < words.length; i++) {
    const v = BigInt(words[i]);
    if (v === 10n || v === 20n || v === BigInt(expected)) hits.push({ i, v: v.toString() });
  }
  return hits;
}

// Packed decoding: treat each 32-byte word as 256 bits and read it as:
//  - 32 bytes (uint8 slots)
//  - 16-bit slots (uint16)
//  - 32-bit slots (uint32)
function unpackWord(wordHex) {
  const clean = wordHex.startsWith("0x") ? wordHex.slice(2) : wordHex;
  const bytes = [];
  for (let i = 0; i < 64; i += 2) bytes.push(parseInt(clean.slice(i, i + 2), 16));

  // bytes are big-endian in the hex string, but packing conventions vary.
  // We’ll produce both “left-to-right” and “right-to-left” interpretations.
  const u8_LR = bytes;
  const u8_RL = [...bytes].reverse();

  function toU16(arr) {
    const out = [];
    for (let i = 0; i < 32; i += 2) out.push((arr[i] << 8) | arr[i + 1]);
    return out;
  }
  function toU32(arr) {
    const out = [];
    for (let i = 0; i < 32; i += 4) out.push((arr[i] << 24) | (arr[i + 1] << 16) | (arr[i + 2] << 8) | arr[i + 3]);
    return out.map(x => x >>> 0);
  }

  return {
    u8_LR, u8_RL,
    u16_LR: toU16(u8_LR),
    u16_RL: toU16(u8_RL),
    u32_LR: toU32(u8_LR),
    u32_RL: toU32(u8_RL),
  };
}

function find10or20Packed(wordHex) {
  const u = unpackWord(wordHex);
  const hits = [];

  const scan = (label, arr) => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i] === 10 || arr[i] === 20) hits.push({ label, slot: i, value: arr[i] });
    }
  };

  scan("u8_LR", u.u8_LR);
  scan("u8_RL", u.u8_RL);
  scan("u16_LR", u.u16_LR);
  scan("u16_RL", u.u16_RL);
  scan("u32_LR", u.u32_LR);
  scan("u32_RL", u.u32_RL);

  return hits;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC);

  console.log("Diamond:", DIAMOND);
  console.log("Blocks :", FROM_BLOCK, "->", TO_BLOCK);
  console.log("");

  for (const t of TARGETS) {
    const topic = topicUint256(t.id);

    console.log("======================================");
    console.log("Tournament:", t.id.toString(), "| expected:", t.expected);
    console.log("======================================");

    // Try tournamentId indexed as topic[1] and topic[2]
    const logs1 = await provider.getLogs({ address: DIAMOND, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK, topics: [null, topic] });
    const logs2 = await provider.getLogs({ address: DIAMOND, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK, topics: [null, null, topic] });

    console.log("topic[1] matches:", logs1.length);
    console.log("topic[2] matches:", logs2.length);

    const logs = [...logs1, ...logs2].slice(0, 30);

    for (let k = 0; k < logs.length; k++) {
      const log = logs[k];
      const words = bytesToWords(log.data);
      const wordHits = scanWordHits(words, t.expected);

      console.log(`\n#${k} block=${log.blockNumber} tx=${log.transactionHash} logIndex=${log.logIndex}`);
      console.log("topic0:", log.topics[0], "| topics:", log.topics.length, "| dataBytes:", (log.data.length - 2) / 2);
      console.log("direct word hits (10/20/expected):", wordHits.length ? JSON.stringify(wordHits) : "none");

      // If no direct hits, try packed hits on first few words (fast)
      let packedFound = false;
      for (let i = 0; i < Math.min(words.length, 8); i++) {
        const packedHits = find10or20Packed(words[i]);
        if (packedHits.length) {
          packedFound = true;
          console.log(`packed hits in word[${i}]:`, JSON.stringify(packedHits));
        }
      }
      if (!packedFound) console.log("packed hits (first 8 words): none");
    }

    console.log("");
  }
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});