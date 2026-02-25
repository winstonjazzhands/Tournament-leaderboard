// scripts/fix-tournament-tiers-dfk-details.js
// ESM script ("type": "module")
//
// Fix tiers by pulling Allowed Hero Level min/max for each tournamentId
// from the DFK tournament details GraphQL endpoint.
//
// Run:
//   node scripts/fix-tournament-tiers-dfk-details.js
//
// Optional env:
//   set DFK_TOURNAMENT_DETAILS_GQL=https://api.defikingdoms.com/graphql/tournament/details

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ENDPOINT =
  process.env.DFK_TOURNAMENT_DETAILS_GQL?.trim() ||
  "https://api.defikingdoms.com/graphql/tournament/details";

const PUBLIC_DIR = path.resolve(__dirname, "..", "public");
const LEADERBOARD_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const CACHE_PATH = path.join(PUBLIC_DIR, "tournamentRanges.json");

const REQUEST_TIMEOUT_MS = 25000;
const BATCH_SIZE = 30;

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

function withTimeout(promiseFactory, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return promiseFactory(ctrl.signal).finally(() => clearTimeout(t));
}

async function postGraphQL(query, variables) {
  return withTimeout(async (signal) => {
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
      throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 200)}`);
    }
    if (!res.ok) {
      throw new Error(
        `HTTP ${res.status} :: ${JSON.stringify(json).slice(0, 500)}`
      );
    }
    return json;
  }, REQUEST_TIMEOUT_MS);
}

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

const INTROSPECT_TYPE = `
query IntrospectType($name: String!) {
  __type(name: $name) {
    name
    kind
    fields {
      name
      type { kind name ofType { kind name ofType { kind name } } }
    }
    inputFields {
      name
      type { kind name ofType { kind name ofType { kind name } } }
    }
  }
}
`;

function unwrapType(t) {
  let cur = t;
  while (cur?.ofType) cur = cur.ofType;
  return cur;
}

function buildTypeString(t) {
  if (!t) return "String";
  if (t.kind === "NON_NULL") return `${buildTypeString(t.ofType)}!`;
  if (t.kind === "LIST") return `[${buildTypeString(t.ofType)}]`;
  return t.name || "String";
}

function isListType(t) {
  // true if top-level is list OR non-null list
  if (!t) return false;
  if (t.kind === "LIST") return true;
  if (t.kind === "NON_NULL") return isListType(t.ofType);
  return false;
}

function lc(s) {
  return String(s || "").toLowerCase();
}

function looksTournamentish(fieldName) {
  const n = lc(fieldName);
  return n.includes("tournament");
}

function argIsIdLike(argName) {
  const n = lc(argName);
  return n === "id" || n === "tournamentid" || n === "tournament_id";
}

function scoreQueryField(f) {
  const name = lc(f.name);
  let score = 0;

  if (!looksTournamentish(name)) return -999;

  if (name === "tournament" || name === "tournamentdetails") score += 50;
  if (name.includes("detail")) score += 20;
  if (name.includes("byid") || name.includes("by_id")) score += 10;

  const args = (f.args || []).map((a) => lc(a.name));
  if (args.some((a) => argIsIdLike(a))) score += 30;
  if (args.includes("where")) score += 10;

  // prefer object return over list, but accept list if needed
  const leaf = unwrapType(f.type);
  if (leaf?.kind === "OBJECT") score += 10;
  if (isListType(f.type)) score -= 5;

  return score;
}

function pickMinMaxFields(typeInfo) {
  const fields = typeInfo?.fields || [];
  if (!fields.length) return null;

  const isNumbery = (field) => {
    const leaf = unwrapType(field.type);
    const n = lc(leaf?.name);
    return leaf?.kind === "SCALAR" && (n === "int" || n === "bigint" || n === "long");
  };

  const scoreField = (field, wantMax) => {
    if (!isNumbery(field)) return -999;
    const n = lc(field.name);
    let s = 0;

    if (n.includes("level")) s += 20;
    if (n.includes("hero")) s += 15;
    if (n.includes("allow")) s += 10;

    if (wantMax) {
      if (n.includes("max")) s += 30;
      if (n.includes("to")) s += 10;
    } else {
      if (n.includes("min")) s += 30;
      if (n.includes("from")) s += 10;
    }

    // very common patterns
    if (!wantMax && (n === "allowedherolevelmin" || n === "minlevel")) s += 60;
    if (wantMax && (n === "allowedherolevelmax" || n === "maxlevel")) s += 60;

    return s;
  };

  const mins = fields
    .map((f) => ({ f, s: scoreField(f, false) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  const maxs = fields
    .map((f) => ({ f, s: scoreField(f, true) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);

  if (!mins.length || !maxs.length) return null;

  const minField = mins[0].f.name;
  const maxField = maxs[0].f.name === minField && maxs.length > 1 ? maxs[1].f.name : maxs[0].f.name;

  if (minField === maxField) return null;

  return { minField, maxField };
}

function deriveTierFromMax(maxLevel) {
  // Your screenshots show Allowed Hero Level 16–20 => should be tier 20
  const m = Number(maxLevel);
  if (!Number.isFinite(m)) return null;
  return m >= 16 ? 20 : 10;
}

async function main() {
  if (!fs.existsSync(LEADERBOARD_PATH)) {
    console.error(`Missing ${LEADERBOARD_PATH}`);
    process.exit(1);
  }

  const lb = readJson(LEADERBOARD_PATH);
  const wins = Array.isArray(lb.wins) ? lb.wins : [];
  const tournamentIds = uniq(wins.map((w) => w.tournamentId).filter(Boolean));

  console.log(`Loaded wins: ${wins.length}`);
  console.log(`Unique tournamentIds: ${tournamentIds.length}`);
  console.log(`GraphQL endpoint: ${ENDPOINT}`);

  let cache = {};
  if (fs.existsSync(CACHE_PATH)) {
    try {
      cache = readJson(CACHE_PATH);
    } catch {
      cache = {};
    }
  }
  console.log(`Cache entries: ${Object.keys(cache).length}`);

  const missing = tournamentIds.filter((id) => cache[String(id)] == null);
  console.log(`Missing tournament ranges: ${missing.length}`);

  // 1) Introspect schema
  const schemaResp = await postGraphQL(INTROSPECT_SCHEMA, {});
  if (schemaResp.errors?.length) {
    throw new Error(`Schema introspection errors: ${JSON.stringify(schemaResp.errors).slice(0, 500)}`);
  }

  const fields = schemaResp.data?.__schema?.queryType?.fields || [];
  if (!fields.length) {
    throw new Error("No query fields returned from schema introspection.");
  }

  // 2) Pick best query field
  const scored = fields
    .map((f) => ({ f, s: scoreQueryField(f) }))
    .filter((x) => x.s > -999)
    .sort((a, b) => b.s - a.s);

  const best = scored[0]?.f;
  if (!best) {
    throw new Error("Could not find a tournament-related query field on this endpoint.");
  }

  const bestName = best.name;
  const args = best.args || [];
  const idArg = args.find((a) => argIsIdLike(a.name));
  const whereArg = args.find((a) => lc(a.name) === "where");

  const returnLeaf = unwrapType(best.type);
  const returnTypeName = returnLeaf?.name;

  console.log(`Using query field: ${bestName}`);
  console.log(`Return type: ${returnTypeName} ${isListType(best.type) ? "(LIST)" : "(OBJECT)"}`);
  console.log(`Args: ${args.map((a) => `${a.name}:${buildTypeString(a.type)}`).join(", ") || "(none)"}`);

  if (!returnTypeName) throw new Error("Could not determine return type name.");

  // If return type is list, we need element type name
  // In introspection, leaf name for list element is still the OBJECT type name, so this usually works.

  // 3) Introspect return type to find min/max fields
  const typeResp = await postGraphQL(INTROSPECT_TYPE, { name: returnTypeName });
  if (typeResp.errors?.length) {
    throw new Error(`Type introspection errors: ${JSON.stringify(typeResp.errors).slice(0, 500)}`);
  }
  const typeInfo = typeResp.data?.__type;
  const minMax = pickMinMaxFields(typeInfo);
  if (!minMax) {
    throw new Error(
      `Could not identify allowed hero level min/max fields on type ${returnTypeName}. Fields: ${(typeInfo?.fields || [])
        .map((f) => f.name)
        .join(", ")}`
    );
  }
  console.log(`Using fields: min=${minMax.minField}, max=${minMax.maxField}`);

  // 4) Build query for either:
  //    A) tournamentDetails(id: X) { min max }
  //    B) tournaments(where: { id: X }) { min max }
  let queryText;
  let mode;

  if (idArg) {
    const idType = buildTypeString(idArg.type);
    queryText = `
      query One($id: ${idType}) {
        t: ${bestName}(${idArg.name}: $id) {
          ${minMax.minField}
          ${minMax.maxField}
        }
      }
    `;
    mode = { kind: "id", argName: idArg.name, argType: idType };
    console.log(`Mode: id-arg (${idArg.name}: ${idType})`);
  } else if (whereArg) {
    // Need to introspect where input fields to see which key to use.
    const whereTypeName = unwrapType(whereArg.type)?.name;
    if (!whereTypeName) throw new Error("where arg exists but could not determine input type name.");

    const whereTypeResp = await postGraphQL(INTROSPECT_TYPE, { name: whereTypeName });
    if (whereTypeResp.errors?.length) {
      throw new Error(`Where type introspection errors: ${JSON.stringify(whereTypeResp.errors).slice(0, 500)}`);
    }
    const whereType = whereTypeResp.data?.__type;
    const inputFields = whereType?.inputFields || [];
    const keys = inputFields.map((f) => f.name);

    const key =
      keys.find((k) => argIsIdLike(k)) ||
      keys.find((k) => lc(k).includes("tournament") && lc(k).includes("id")) ||
      keys.find((k) => lc(k) === "id");

    if (!key) {
      throw new Error(`Could not find an id-like key in where input. Keys: ${keys.join(", ")}`);
    }

    // We also need to know the field name that returns list length 1;
    // We'll just take the first item.
    queryText = `
      query One($where: ${buildTypeString(whereArg.type)}) {
        ts: ${bestName}(where: $where, first: 1) {
          ${minMax.minField}
          ${minMax.maxField}
        }
      }
    `;
    mode = { kind: "where", whereKey: key, whereTypeName };
    console.log(`Mode: where-arg (where.{${key}} = tournamentId)`);
  } else {
    throw new Error("Chosen query field had neither id arg nor where arg — cannot query by tournamentId.");
  }

  // Helper to coerce id
  function coerceId(typeStr, tid) {
    const t = typeStr.replace(/[\[\]!]/g, "").toLowerCase();
    if (t.includes("int") || t.includes("bigint") || t.includes("long")) return Number(tid);
    return String(tid);
  }

  // 5) Fetch missing
  let fetched = 0;
  for (let i = 0; i < missing.length; i += BATCH_SIZE) {
    const batch = missing.slice(i, i + BATCH_SIZE);
    console.log(`Fetching ${i + 1}–${i + batch.length} / ${missing.length}`);

    for (const tid of batch) {
      try {
        let vars;
        if (mode.kind === "id") {
          vars = { id: coerceId(mode.argType, tid) };
        } else {
          vars = { where: { [mode.whereKey]: String(tid) } };
        }

        const resp = await postGraphQL(queryText, vars);
        if (resp.errors?.length) continue;

        const rec =
          mode.kind === "id"
            ? resp.data?.t
            : Array.isArray(resp.data?.ts)
            ? resp.data.ts[0]
            : null;

        if (!rec) continue;

        const minV = rec[minMax.minField];
        const maxV = rec[minMax.maxField];

        if (minV == null && maxV == null) continue;

        cache[String(tid)] = {
          minLevel: minV != null ? Number(minV) : null,
          maxLevel: maxV != null ? Number(maxV) : null,
          source: ENDPOINT,
          fetchedAtUtc: new Date().toISOString(),
        };
        fetched++;
      } catch {
        // ignore per-tournament failures
      }
    }

    writeJson(CACHE_PATH, cache);
    console.log(`Cache saved. fetched=${fetched}`);
  }

  // 6) Apply tier updates
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
  console.log(`changedWins=${changed}`);
  console.log(`unresolvedWins=${unresolved}`);
  console.log(`Wrote ${CACHE_PATH}`);
  console.log(`Wrote ${LEADERBOARD_PATH}`);
}

main().catch((e) => {
  console.error("Fatal:", e.message || e);
  process.exit(1);
});