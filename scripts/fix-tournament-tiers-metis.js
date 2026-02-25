// scripts/fix-tournament-tiers_metis.js
// ESM script (your project has "type": "module")

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { JsonRpcProvider, Contract } from "ethers";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ====== CONFIG ======
const RPC =
  process.env.METIS_RPC ||
  "https://andromeda.metis.io/?owner=1088";

// Your Tournament Diamond on Metis (from your earlier output)
const TOURNAMENT_DIAMOND =
  (process.env.TOURNAMENT_DIAMOND ||
    "0xc7681698B14a2381d9f1eD69FC3D27F33965b53B").toLowerCase();

// Where your site reads leaderboard.json from
const LEADERBOARD_PATH =
  process.env.LEADERBOARD_PATH ||
  path.resolve(__dirname, "..", "public", "leaderboard.json");

// Chunk size for ID probing to avoid hammering RPC too hard
const ID_BATCH = Number(process.env.ID_BATCH || 40);

// ====== Helpers ======
function die(msg) {
  console.error(msg);
  process.exit(1);
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveJson(p, obj) {
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function isIntLike(x) {
  return typeof x === "number" || typeof x === "bigint";
}

// Heuristic:
// scan returned tuple/object for small integers that *look* like levels (1..100)
// we take the largest plausible "level" as maxLevel
function extractMaxLevelFromReturn(ret) {
  const candidates = [];

  const pushCandidate = (v) => {
    if (!isIntLike(v)) return;
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    if (n >= 1 && n <= 100) candidates.push(n);
  };

  const walk = (v) => {
    if (v == null) return;

    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }

    if (typeof v === "object") {
      // ethers v6 Result is array-like but also has named props
      for (const k of Object.keys(v)) {
        // skip numeric keys to avoid duplicates; the array part already covers them
        if (/^\d+$/.test(k)) continue;
        walk(v[k]);
      }
      return;
    }

    pushCandidate(v);
  };

  walk(ret);
  if (candidates.length === 0) return null;
  return Math.max(...candidates);
}

function tierFromMaxLevel(maxLevel) {
  if (maxLevel == null) return null;
  if (maxLevel <= 10) return 10;
  if (maxLevel <= 15) return 15;
  return 20;
}

// ====== Probe contract for a "tournament details" function ======
// We try several common names/signatures used in DFK-style contracts.
// The goal: find ANY callable view function that accepts (uint256 id)
// and returns something containing the level range (or at least max level).
const CANDIDATE_ABIS = [
  "function tournaments(uint256) view returns (tuple())",
  "function tournament(uint256) view returns (tuple())",
  "function getTournament(uint256) view returns (tuple())",
  "function getTournamentInfo(uint256) view returns (tuple())",
  "function getTournamentDetails(uint256) view returns (tuple())",
  "function getTournamentConfig(uint256) view returns (tuple())",
  "function getTournamentSettings(uint256) view returns (tuple())",
  "function getTournamentMetadata(uint256) view returns (tuple())",
  "function getTournamentById(uint256) view returns (tuple())",

  // Sometimes just returns level range directly
  "function getLevelRange(uint256) view returns (uint8 minLevel, uint8 maxLevel)",
  "function getAllowedHeroLevels(uint256) view returns (uint8 minLevel, uint8 maxLevel)",
  "function getAllowedHeroLevelRange(uint256) view returns (uint8 minLevel, uint8 maxLevel)",
  "function getTournamentLevelRange(uint256) view returns (uint8 minLevel, uint8 maxLevel)",
];

async function findWorkingReader(provider, sampleTournamentId) {
  for (const sig of CANDIDATE_ABIS) {
    const abi = [sig];
    const c = new Contract(TOURNAMENT_DIAMOND, abi, provider);

    // method name is between "function " and "("
    const name = sig.match(/^function\s+([^(]+)\(/)?.[1];
    if (!name) continue;

    try {
      const ret = await c[name](sampleTournamentId);

      // direct level range case
      if (ret && typeof ret === "object") {
        const maxDirect =
          ret.maxLevel ?? ret[1] ?? null;

        // Use heuristic scan either way
        const maxLevel = extractMaxLevelFromReturn(ret) ?? (maxDirect != null ? Number(maxDirect) : null);

        const tier = tierFromMaxLevel(maxLevel);
        if (tier != null) {
          return { name, abi, sig, example: { maxLevel, tier } };
        }
      }
    } catch (_) {
      // ignore and continue
    }
  }
  return null;
}

async function main() {
  if (!fs.existsSync(LEADERBOARD_PATH)) {
    die(`Could not find leaderboard.json at: ${LEADERBOARD_PATH}`);
  }

  const leaderboard = loadJson(LEADERBOARD_PATH);
  if (!leaderboard?.wins || !Array.isArray(leaderboard.wins)) {
    die("leaderboard.json missing wins[]");
  }

  const ids = uniq(leaderboard.wins.map((w) => w.tournamentId)).filter(
    (x) => typeof x === "number" && Number.isFinite(x)
  );

  console.log(`Loaded wins: ${leaderboard.wins.length}`);
  console.log(`Unique tournamentIds: ${ids.length}`);
  console.log(`RPC: ${RPC}`);
  console.log(`TournamentDiamond: ${TOURNAMENT_DIAMOND}`);

  if (ids.length === 0) {
    console.log("No tournamentIds found. Nothing to do.");
    return;
  }

  const provider = new JsonRpcProvider(RPC);

  // pick a sample id that exists
  const sampleId = ids[Math.floor(ids.length / 2)] ?? ids[0];
  console.log(`Probing readable tournament function using sampleId=${sampleId}...`);

  const reader = await findWorkingReader(provider, sampleId);
  if (!reader) {
    die(
      [
        "Could not find a readable tournament-details function on the diamond using the built-in candidates.",
        "Next step: we add the correct ABI for the tournament details facet, or we expand candidate signatures.",
        "Tell me what chain/UI contract you’re using for tournament details, and I’ll lock this in.",
      ].join("\n")
    );
  }

  console.log(`✅ Using reader: ${reader.name}`);
  console.log(`Example extracted: maxLevel=${reader.example.maxLevel} => tier=${reader.example.tier}`);

  const contract = new Contract(TOURNAMENT_DIAMOND, reader.abi, provider);

  // Resolve tiers per tournamentId
  const idToTier = new Map();
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < ids.length; i += ID_BATCH) {
    const batch = ids.slice(i, i + ID_BATCH);

    const results = await Promise.allSettled(
      batch.map(async (id) => {
        const ret = await contract[reader.name](id);
        const maxLevel = extractMaxLevelFromReturn(ret);
        const tier = tierFromMaxLevel(maxLevel);
        if (tier == null) throw new Error("could not infer tier");
        return { id, tier, maxLevel };
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled") {
        ok++;
        idToTier.set(r.value.id, r.value.tier);
      } else {
        fail++;
      }
    }

    console.log(
      `Processed ${Math.min(i + ID_BATCH, ids.length)}/${ids.length} | ok=${ok} fail=${fail}`
    );
  }

  // Rewrite wins with corrected tiers (only where we successfully resolved)
  let changed = 0;
  for (const w of leaderboard.wins) {
    const newTier = idToTier.get(w.tournamentId);
    if (newTier != null && w.tier !== newTier) {
      w.tier = newTier;
      changed++;
    }
  }

  // refresh counters at top-level if you store them
  if (typeof leaderboard.totalWins === "number") {
    leaderboard.totalWins = leaderboard.wins.length;
  }

  leaderboard.updatedAtUtc = new Date().toISOString();
  leaderboard.source = "chain/tournamentDetails";
  leaderboard.tierFix = {
    tournamentDiamond: TOURNAMENT_DIAMOND,
    rpc: RPC,
    resolvedTournaments: idToTier.size,
    changedWins: changed,
    readerFunction: reader.name,
    readerSignature: reader.sig,
  };

  saveJson(LEADERBOARD_PATH, leaderboard);

  console.log(`✅ Wrote: ${LEADERBOARD_PATH}`);
  console.log(`✅ Tiers updated on ${changed} win rows.`);
  console.log(`✅ Resolved tournaments: ${idToTier.size}/${ids.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});