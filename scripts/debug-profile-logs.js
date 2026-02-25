import { ethers } from "ethers";

const RPC = "https://andromeda.metis.io/?owner=1088";
const CONTRACT = "0x5477d7f1539adc67787aea54306700196b81e7c4";
const TOPIC0 =
  "0x2c1415cbda85739695d2c281e25308b9c194f40490b09151d6cdf3c1dffd435d";

const provider = new ethers.JsonRpcProvider(RPC);
const coder = ethers.AbiCoder.defaultAbiCoder();

function topicToAddress(topic) {
  return "0x" + topic.toLowerCase().slice(26);
}

async function main() {
  const latest = await provider.getBlockNumber();
  const start = Math.max(0, latest - 2_000_000);

  const logs = await provider.getLogs({
    address: CONTRACT,
    fromBlock: start,
    toBlock: latest,
    topics: [TOPIC0],
  });

  console.log("logs:", logs.length);

  logs.forEach((log, i) => {
    const wallet = log.topics?.[1] ? topicToAddress(log.topics[1]) : null;
    console.log("\n#", i + 1);
    console.log("block:", log.blockNumber);
    console.log("wallet:", wallet);
    console.log("data:", log.data);

    // Try a few decodes
    for (const types of [["string"], ["uint256", "string"], ["address", "string"], ["uint256", "address", "string"]]) {
      try {
        const dec = coder.decode(types, log.data);
        console.log("decode", types.join(","), "=>", dec);
      } catch {}
    }
  });
}

main().catch(console.error);