// scripts/fix-tournament-tiers-graphql.js
// ESM script (your scripts/package.json has "type": "module")
//
// What it does:
// - Reads ./public/leaderboard.json (wins with tournamentId + tier)
// - Uses GraphQL introspection on DFK API to find how to query tournament details
// - Fetches allowed hero level min/max for each tournamentId
// - Rewrites win.tier based on the max allowed level (>=16 => 20 else 10)
// - Writes:
//    - ./public/tournamentRanges.json (cache)
//    - ./public/leaderboard.json (updated)
//
// Run:
//   node scripts/fix-tournament-tiers-graphql.js
//
// Optional env:
//   set DFK_TOURNAMENT_GQL=https://api.defikingdoms.com/graphql

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---- Config ----
const ENDPOINT =
  process.env.DFK_TOURNAMENT_GQL?.trim() || "https://api.defikingdoms.com/graphql";

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const LEADERBOARD_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const CACHE_PATH = path.join(PUBLIC_DIR, "tournamentRanges.json");

// Chunk sizes
const TOURNAMENT_BATCH_SIZE = 40; // how many tournamentIds per loop (we still query one-by-one unless schema supports arrays)
const REQUEST_TIMEOUT_MS = 25_000;

// ---- Helpers ----
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function uniq(arr) {
  return Array.from(new Set(arr));
}

function isObject(x) {
  return x && typeof x === "object" && !Array.isArray(x);
}

function withTimeout(promise, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return {
    promise: (async () => {
      try {
        return await promise(ctrl.signal);
      } finally {
        clearTimeout(t);
      }
    })(),
  };
}

async function postGraphQL(query, variables) {
  const { promise } = withTimeout(async (signal) => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
      signal,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} from ${ENDPOINT} :: ${JSON.stringify(json).slice(0, 500)}`
      );
    }
    return json;
  }, REQUEST_TIMEOUT_MS);

  return await promise;
}

// GraphQL introspection queries
const INTROSPECT_SCHEMA = `
query IntrospectSchema {
  __schema {
    queryType {
      name
      fields {
        name
        args {
          name
          type { kind name ofType { kind name ofType { kind name } } }
        }
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }
}
`;

function unwrapType(t) {
  // returns deepest named type (OBJECT/SCALAR/etc)
  let cur = t;
  while (cur && cur.ofType) cur = cur.ofType;
  return cur;
}

async function introspectSchema() {
  const resp = await postGraphQL(INTROSPECT_SCHEMA, {});
  if (resp.errors?.length) {
    throw new Error(`Introspection failed: ${JSON.stringify(resp.errors).slice(0, 500)}`);
  }
  return resp.data?.__schema;
}

async function introspectType(typeName) {
  const q = `
  query IntrospectType($name: String!) {
    __type(name: $name) {
      name
      kind
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
      }
    }
  }`;
  const resp = await postGraphQL(q, { name: typeName });
  if (resp.errors?.length) {
    throw new Error(`Type introspection failed: ${JSON.stringify(resp.errors).slice(0, 500)}`);
  }
  return resp.data?.__type;
}

function looksLikeTournamentField(fieldName) {
  const n = fieldName.toLowerCase();
  return n.includes("tournament");
}

function argLooksLikeId(argName) {
  const n = argName.toLowerCase();
  return n === "id" || n === "tournamentid" || n === "tournament_id";
}

function scoreTournamentQueryField(f) {
  // higher is better
  let score = 0;
  const name = f.name.toLowerCase();
  if (name === "tournament") score += 50;
  if (name.includes("details")) score += 15;
  if (name.includes("byid") || name.includes("by_id")) score += 10;
  if (looksLikeTournamentField(f.name)) score += 10;

  const argNames = (f.args || []).map((a) => a.name.toLowerCase());
  if (argNames.some((a) => a === "id")) score += 25;
  if (argNames.some((a) => a.includes("tournament"))) score += 15;

  // Prefer fields that return an OBJECT (not list)
  const leaf = unwrapType(f.type);
  if (leaf?.kind === "OBJECT") score += 10;

  return score;
}

function findBestTournamentQueryField(schema) {
  const fields = schema?.queryType?.fields || [];
  const candidates = fields
    .filter((f) => looksLikeTournamentField(f.name))
    .filter((f) => (f.args || []).some((a) => argLooksLikeId(a.name)));

  if (!candidates.length) return null;

  candidates.sort((a, b) => scoreTournamentQueryField(b) - scoreTournamentQueryField(a));
  return candidates[0];
}

function pickMinMaxFields(typeInfo) {
  // We try to find 2 numeric-ish fields that look like min/max allowed hero level.
  const fields = typeInfo?.fields || [];
  const names = fields.map((f) => f.name);

  const lc = (s) => s.toLowerCase();

  const isNumbery = (field) => {
    const leaf = unwrapType(field.type);
    const k = leaf?.name?.toLowerCase();
    return (
      leaf?.kind === "SCALAR" &&
      (k === "int" || k === "bigint" || k === "long" || k === "float" || k === "number")
    );
  };

  // Scoring function for likely min/max fields
  const scoreField = (field, wantMax) => {
    const n = lc(field.name);
    let s = 0;
    if (!isNumbery(field)) return -999;

    if (n.includes("level")) s += 20;
    if (n.includes("hero")) s += 15;
    if (n.includes("allowed")) s += 10;

    if (wantMax) {
      if (n.includes("max")) s += 25;
      if (n.endsWith("to")) s += 10;
    } else {
      if (n.includes("min")) s += 25;
      if (n.endsWith("from")) s += 10;
    }

    // common names we’ve seen across APIs:
    if (!wantMax && (n === "minlevel" || n === "allowedherolevelmin")) s += 40;
    if (wantMax && (n === "maxlevel" || n === "allowedherolevelmax")) s += 40;

    return s;
  };

  const minCandidates = fields
    .map((f) => ({ f, s: scoreField(f, false) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const maxCandidates = fields
    .map((f) => ({ f, s: scoreField(f, true) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (!minCandidates.length || !maxCandidates.length) {
    return null;
  }

  const minField = minCandidates[0].f;
  const maxField = maxCandidates[0].f;

  // Avoid selecting the same field for both
  if (minField.name === maxField.name) {
    // try the next best max
    if (maxCandidates.length > 1) return { minField: minField.name, maxField: maxCandidates[1].f.name };
    return null;
  }

  return { minField: minField.name, maxField: maxField.name };
}

function gqlTypeForArg(arg) {
  // Rebuild GraphQL arg type string from introspection type object
  // Example: NON_NULL -> SCALAR(Int) => "Int!"
  function build(t) {
    if (!t) return "String";
    if (t.kind === "NON_NULL") return `${build(t.ofType)}!`;
    if (t.kind === "LIST") return `[${build(t.ofType)}]`;
    return t.name || (t.ofType ? build(t.ofType) : "String");
  }
  return build(arg.type);
}

function coerceIdValue(typeStr, tournamentId) {
  // If GraphQL arg type is Int/BigInt/etc, pass number; else pass string
  const t = typeStr.replace(/[\[\]!]/g, "").toLowerCase();
  if (t.includes("int") || t.includes("bigint") || t.includes("long") || t.includes("number")) {
    return Number(tournamentId);
  }
  return String(tournamentId);
}

function deriveTierFromMax(maxLevel) {
  // Your UI examples:
  // - "Allowed Hero Level 16 to 20" => should count as 20 tier
  // In practice, DFK tiers are typically 10 and 20.
  // So: max >= 16 -> 20 else -> 10.
  if (maxLevel == null) return null;
  const m = Number(maxLevel);
  if (!Number.isFinite(m)) return null;
  return m >= 16 ? 20 : 10;
}

async function main() {
  if (!fs.existsSync(LEADERBOARD_PATH)) {
    console.error(`Missing ${LEADERBOARD_PATH}. Make sure you have public/leaderboard.json first.`);
    process.exit(1);
  }

  const lb = readJson(LEADERBOARD_PATH);
  const wins = Array.isArray(lb.wins) ? lb.wins : [];
  const tournamentIds = uniq(wins.map((w) => w.tournamentId).filter((x) => x != null));

  console.log(`Loaded wins: ${wins.length}`);
  console.log(`Unique tournamentIds: ${tournamentIds.length}`);
  console.log(`GraphQL endpoint: ${ENDPOINT}`);

  // Load cache
  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try {
      cache = readJson(CACHE_PATH);
    } catch {
      cache = {};
    }
  }
  const cachedCount = Object.keys(cache).length;
  console.log(`Cache entries: ${cachedCount}`);

  const missing = tournamentIds.filter((id) => cache[String(id)] == null);
  console.log(`Missing tournament ranges: ${missing.length}`);

  if (!missing.length) {
    console.log("Nothing to fetch. Applying tiers from cache...");
  }

  // Introspect schema (once)
  const schema = await introspectSchema();
  const queryField = findBestTournamentQueryField(schema);

  if (!queryField) {
    console.error("Could not find a tournament query field via introspection.");
    console.error("Schema query fields did not include something like tournament(id: ...).");
    process.exit(1);
  }

  const idArg = (queryField.args || []).find((a) => argLooksLikeId(a.name));
  if (!idArg) {
    console.error("Found tournament query field but could not find an id-like arg.");
    process.exit(1);
  }

  const idArgType = gqlTypeForArg(idArg);
  const returnLeaf = unwrapType(queryField.type);
  const returnTypeName = returnLeaf?.name;

  console.log(`Using query field: ${queryField.name}(${idArg.name}: ${idArgType}) -> ${returnTypeName}`);

  if (!returnTypeName) {
    console.error("Could not determine return type name.");
    process.exit(1);
  }

  const typeInfo = await introspectType(returnTypeName);
  const minMax = pickMinMaxFields(typeInfo);

  if (!minMax) {
    console.error(`Could not identify min/max level fields on type ${returnTypeName}.`);
    console.error("Type fields were:", (typeInfo?.fields || []).map((f) => f.name).join(", "));
    process.exit(1);
  }

  console.log(`Using fields: min=${minMax.minField}, max=${minMax.maxField}`);

  // Build a query for a single tournament
  const TOURNAMENT_QUERY = `
    query TournamentById($id: ${idArgType}) {
      t: ${queryField.name}(${idArg.name}: $id) {
        ${minMax.minField}
        ${minMax.maxField}
      }
    }
  `;

  // Fetch missing tournament ranges
  let fetched = 0;
  for (let i = 0; i < missing.length; i += TOURNAMENT_BATCH_SIZE) {
    const batch = missing.slice(i, i + TOURNAMENT_BATCH_SIZE);
    console.log(`Fetch batch ${Math.floor(i / TOURNAMENT_BATCH_SIZE) + 1}/${Math.ceil(missing.length / TOURNAMENT_BATCH_SIZE)} (${batch.length} tournaments)`);

    for (const tid of batch) {
      const idValue = coerceIdValue(idArgType, tid);

      try {
        const resp = await postGraphQL(TOURNAMENT_QUERY, { id: idValue });
        if (resp.errors?.length) {
          console.warn(`Tournament ${tid} errors: ${JSON.stringify(resp.errors).slice(0, 300)}`);
          continue;
        }

        const t = resp.data?.t;
        if (!t || !isObject(t)) {
          // not found
          continue;
        }

        const minV = t[minMax.minField];
        const maxV = t[minMax.maxField];

        // Only cache if we got something usable
        if (minV != null || maxV != null) {
          cache[String(tid)] = {
            minLevel: minV != null ? Number(minV) : null,
            maxLevel: maxV != null ? Number(maxV) : null,
            source: ENDPOINT,
            fetchedAtUtc: new Date().toISOString(),
          };
          fetched++;
        }

        // tiny delay to be polite
        await sleep(30);
      } catch (e) {
        console.warn(`Tournament ${tid} fetch failed: ${e.message}`);
        // continue
      }
    }

    // Save cache progressively
    writeJson(CACHE_PATH, cache);
    console.log(`Cache saved. Total fetched this run: ${fetched}`);
  }

  // Apply tier updates
  let changed = 0;
  let unresolved = 0;

  for (const w of wins) {
    const entry = cache[String(w.tournamentId)];
    const tier = deriveTierFromMax(entry?.maxLevel);

    if (tier == null) {
      unresolved++;
      continue;
    }

    if (w.tier !== tier) {
      w.tier = tier;
      changed++;
    }
  }

  lb.wins = wins;
  lb.updatedAtUtc = new Date().toISOString();
  lb.tiersFixed = {
    endpoint: ENDPOINT,
    cacheFile: "public/tournamentRanges.json",
    changedWins: changed,
    unresolvedWins: unresolved,
  };

  writeJson(LEADERBOARD_PATH, lb);

  console.log(`Done.`);
  console.log(`Updated wins with tier changes: ${changed}`);
  console.log(`Wins still unresolved (no maxLevel): ${unresolved}`);
  console.log(`Wrote: ${CACHE_PATH}`);
  console.log(`Wrote: ${LEADERBOARD_PATH}`);
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});