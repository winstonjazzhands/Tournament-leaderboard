// scripts/profile-match-logs.js
import { ethers } from "ethers";

const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";
const MATCH_TOPIC0 = "0x2b93f4474a262323163bea734586863c91186f8230b05f68ba8018bac0a65897";

function splitWords(dataHex) {
  const data = dataHex.startsWith("0x") ? dataHex.slice(2) : dataHex;
  const words = [];
  for (let i = 0; i < data.length; i += 64) words.push("0x" + data.slice(i, i + 64));
  return words;
}
const u = (hex) => BigInt(hex);

async function main(){
  const rpcUrl = process.env.RPC_URL;
  if (!rpcUrl) throw new Error("Set RPC_URL first.");
  const fromBlock = Number(process.argv[2] ?? 22000000);
  const toBlock   = Number(process.argv[3] ?? 22320000);

  const provider = new ethers.JsonRpcProvider(rpcUrl);

  const logs = await provider.getLogs({ address: DIAMOND, fromBlock, toBlock, topics: [MATCH_TOPIC0] });
  console.log("match logs:", logs.length);

  const topics1 = new Set();
  const topics2 = new Set();
  const topics3 = new Set();

  const wUniques = Array.from({length: 8}, () => new Set()); // first 8 words

  for (const l of logs){
    if (l.topics?.[1]) topics1.add(l.topics[1]);
    if (l.topics?.[2]) topics2.add(l.topics[2]);
    if (l.topics?.[3]) topics3.add(l.topics[3]);

    const words = splitWords(l.data);
    for (let i=0;i<Math.min(words.length, 8);i++){
      wUniques[i].add(u(words[i]).toString());
    }
  }

  console.log("unique topic1:", topics1.size);
  console.log("unique topic2:", topics2.size);
  console.log("unique topic3:", topics3.size);
  for (let i=0;i<wUniques.length;i++){
    console.log(`unique w${i}:`, wUniques[i].size);
  }
}

main().catch(e=>{ console.error(e); process.exit(1); });