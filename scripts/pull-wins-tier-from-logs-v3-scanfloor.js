import fs from "fs";
import path from "path";
import { ethers } from "ethers";

const SUBGRAPH_URL =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const RPC_URL = "https://andromeda.metis.io/?owner=1088";
const DIAMOND = "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B";

const SCAN_MIN_BLOCK = 21000000; // ✅ your requested floor (log scans only)

const LOOKBACK_FAST = 150000;
const LOOKBACK_SLOW = 600000;
const CHUNK_SIZE = 2000;

const PAGE_SIZE = 1000;
const MAX_PAGES = 8000;

const OUT_FILE = path.join(process.cwd(), "public", "leaderboard.json");
const CACHE_DIR = path.join(process.cwd(), "scripts", ".cache");
const CACHE_FILE = path.join(CACHE_DIR, "tournament-tier-from-logs-cache.json");

function nowUtcIso() { return new Date().toISOString(); }

async function gql(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json)}`);
  if (json?.errors?.length) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

function toInt(x){ const n=Number(x); return Number.isFinite(n)?Math.trunc(n):null; }
function normalizeWallet(p){
  if(!p) return null;
  if(typeof p==="string") return p.toLowerCase();
  if(typeof p==="object" && typeof p.id==="string") return p.id.toLowerCase();
  return null;
}

function loadCache(){
  try{ if(fs.existsSync(CACHE_FILE)) return JSON.parse(fs.readFileSync(CACHE_FILE,"utf8")); }
  catch{}
  return {};
}
function saveCache(cache){
  fs.mkdirSync(CACHE_DIR,{recursive:true});
  fs.writeFileSync(CACHE_FILE,JSON.stringify(cache,null,2));
}

function tidWordHex(id){
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(id)),32).slice(2).toLowerCase();
}

function splitWords(dataHex){
  const hex=(dataHex||"0x").replace(/^0x/,"");
  const words=[];
  for(let i=0;i+64<=hex.length;i+=64) words.push("0x"+hex.slice(i,i+64));
  return words;
}
function wordToSafeNumber(w){
  try{
    const bi=BigInt(w);
    if(bi>BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return Number(bi);
  }catch{ return null; }
}
function extractTier(words){
  const nums=words.map(wordToSafeNumber);
  // pick first clear 10/20; prefer 20 if both present
  let saw10=false, saw20=false;
  for(const n of nums){
    if(n===10) saw10=true;
    if(n===20) saw20=true;
  }
  if(saw20) return 20;
  if(saw10) return 10;
  return null;
}

function logMentionsTid(log,tidWord){
  if(Array.isArray(log.topics)){
    for(const t of log.topics){
      if(typeof t==="string" && t.toLowerCase().includes(tidWord)) return true;
    }
  }
  const dataHex=(log.data||"").toLowerCase().replace(/^0x/,"");
  if(dataHex.includes(tidWord)) return true;
  return false;
}

async function scan(provider,tid,winBlock,lookback){
  const fromBlock=Math.max(SCAN_MIN_BLOCK, winBlock-lookback);
  const toBlock=winBlock;
  const tidWord=tidWordHex(tid);

  for(let start=fromBlock; start<=toBlock; start+=CHUNK_SIZE){
    const end=Math.min(toBlock,start+CHUNK_SIZE-1);
    let logs=[];
    try{
      logs=await provider.getLogs({ address: DIAMOND, fromBlock:start, toBlock:end });
    }catch{ continue; }

    for(const log of logs){
      if(!logMentionsTid(log,tidWord)) continue;
      const tier=extractTier(splitWords(log.data||"0x"));
      if(tier===10 || tier===20){
        return { tier, matchedBlock:log.blockNumber, updatedAtUtc: nowUtcIso() };
      }
    }
  }
  return null;
}

async function main(){
  console.log("[v3-scanfloor] SCAN_MIN_BLOCK:", SCAN_MIN_BLOCK);

  // Pull wins
  const winsRaw=[];
  for(let page=0;page<MAX_PAGES;page++){
    const skip=page*PAGE_SIZE;
    const data=await gql(
      `query($first:Int!,$skip:Int!){
        tournamentWins(first:$first,skip:$skip,orderBy:timestamp,orderDirection:asc){
          id timestamp tournamentId blockNumber player{ id }
        }
      }`,
      { first:PAGE_SIZE, skip }
    );
    const batch=data?.tournamentWins||[];
    winsRaw.push(...batch);
    console.log(`[v3-scanfloor] page=${page} batch=${batch.length} total=${winsRaw.length}`);
    if(batch.length<PAGE_SIZE) break;
  }

  const wins=winsRaw
    .map(w=>({
      id:String(w.id),
      wallet:normalizeWallet(w.player),
      timestamp:toInt(w.timestamp),
      tournamentId:String(w.tournamentId),
      blockNumber:toInt(w.blockNumber),
      tier:null
    }))
    .filter(w=>w.wallet && w.timestamp && w.tournamentId && w.blockNumber);

  console.log("[v3-scanfloor] wins:", wins.length);

  const provider=new ethers.JsonRpcProvider(RPC_URL);
  const cache=loadCache();

  // Unique tournament ids
  const tids=[...new Set(wins.map(w=>w.tournamentId))];

  // pick a representative win block for each tid
  const tidToWinBlock=new Map();
  for(const w of wins){
    const prev=tidToWinBlock.get(w.tournamentId)||0;
    if(w.blockNumber>prev) tidToWinBlock.set(w.tournamentId,w.blockNumber);
  }

  const missing=tids.filter(t=>!cache[t] || (cache[t].tier!==10 && cache[t].tier!==20));
  console.log("[v3-scanfloor] missing tiers:", missing.length);

  for(let i=0;i<missing.length;i++){
    const tid=missing[i];
    const winBlock=tidToWinBlock.get(tid);
    if(!winBlock) continue;

    console.log(`[v3-scanfloor] FAST ${i+1}/${missing.length} tid=${tid}`);
    let found=await scan(provider,Number(tid),winBlock,LOOKBACK_FAST);

    if(!found){
      console.log(`[v3-scanfloor] SLOW ${i+1}/${missing.length} tid=${tid}`);
      found=await scan(provider,Number(tid),winBlock,LOOKBACK_SLOW);
    }

    if(found){
      cache[tid]=found;
      console.log(`[v3-scanfloor]  ✅ tier=${found.tier} matchedBlock=${found.matchedBlock}`);
      saveCache(cache);
    }else{
      cache[tid]={ tier:null, updatedAtUtc: nowUtcIso() };
      if((i+1)%25===0) saveCache(cache);
    }
  }

  saveCache(cache);

  // Apply tiers & aggregate
  let unknownTierWins=0;
  const byWallet=new Map();

  for(const w of wins){
    w.tier=cache[w.tournamentId]?.tier ?? null;
    if(w.tier!==10 && w.tier!==20) unknownTierWins++;

    const cur=byWallet.get(w.wallet) || { wallet:w.wallet, lvl10Wins:0, lvl20Wins:0, unknownWins:0, lastWin:0 };
    if(w.timestamp>cur.lastWin) cur.lastWin=w.timestamp;
    if(w.tier===10) cur.lvl10Wins++;
    else if(w.tier===20) cur.lvl20Wins++;
    else cur.unknownWins++;
    byWallet.set(w.wallet,cur);
  }

  const leaderboard=[...byWallet.values()]
    .map(x=>({ ...x, totalWins:x.lvl10Wins+x.lvl20Wins+x.unknownWins }))
    .sort((a,b)=>b.totalWins-a.totalWins || b.lastWin-a.lastWin || a.wallet.localeCompare(b.wallet))
    .map((x,i)=>({ rank:i+1, ...x }));

  const out={
    updatedAtUtc: nowUtcIso(),
    source: "graph-studio/1.7 + log-tier-cache (scan floor)",
    rpc: RPC_URL,
    tournamentDiamond: DIAMOND,
    scanMinBlock: SCAN_MIN_BLOCK,
    totalWins: wins.length,
    uniqueTournaments: tids.length,
    unknownTierWins,
    wins,
    leaderboard
  };

  fs.mkdirSync(path.dirname(OUT_FILE),{recursive:true});
  fs.writeFileSync(OUT_FILE,JSON.stringify(out,null,2));

  console.log(`[v3-scanfloor] wrote ${OUT_FILE}`);
  console.log(`[v3-scanfloor] unknownTierWins=${unknownTierWins}`);
}

main().catch(e=>{ console.error("[v3-scanfloor] fatal:",e); process.exit(1); });