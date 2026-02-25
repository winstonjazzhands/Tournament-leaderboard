/**
 * Build/refresh public/tournamentRanges.json by querying your existing tournament-leaderboards subgraph.
 *
 * Why:
 * - The win logs only have tournamentId.
 * - Tier (10 vs 20) is determined by tournament level range (e.g., 16-20 => tier 20).
 * - Your leaderboard.json can have incorrect tier values.
 *
 * This script tries to auto-discover a "tournament" entity in the schema that has:
 * - tournamentId (or id)
 * - minLevel/minHeroLevel + maxLevel/maxHeroLevel
 *
 * Then it writes:
 *  public/tournamentRanges.json
 *
 * Usage:
 *   node scripts/fix-tournament-tiers-subgraph.js
 *
 * Env:
 *   SUBGRAPH_URL="https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7"
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const LEADERBOARD_JSON = path.join(PUBLIC_DIR, "leaderboard.json");
const OUT_RANGES_JSON = path.join(PUBLIC_DIR, "tournamentRanges.json");

const SUBGRAPH_URL =
  process.env.SUBGRAPH_URL ||
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

async function gql(query, variables = {}) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg = json.errors?.[0]?.message || `${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return json.data;
}

const INTROSPECTION = `
query Introspection {
  __schema {
    queryType { name }
    types {
      kind
      name
      fields {
        name
        type { kind name ofType { kind name ofType { kind name } } }
        args { name type { kind name ofType { kind name ofType { kind name } } } }
      }
    }
  }
}`;

function unwrap(t) {
  let cur = t;
  while (cur && (cur.kind === "NON_NULL" || cur.kind === "LIST")) cur = cur.ofType;
  return cur;
}

function pickTournamentListQueries(schema) {
  const queryTypeName = schema.__schema.queryType.name;
  const queryType = schema.__schema.types.find((t) => t.name === queryTypeName);
  const fields = queryType?.fields || [];
  const out = [];
  for (const f of fields) {
    const name = f.name.toLowerCase();
    if (!name.includes("tournament")) continue;
    // must return a list of objects
    const base = unwrap(f.type);
    if (!base || base.kind !== "OBJECT") continue;
    out.push({ fieldName: f.name, objectType: base.name });
  }
  return out;
}

function findLevelFields(typeDef) {
  const names = (typeDef?.fields || []).map((x) => x.name);
  const lc = (s) => s.toLowerCase();

  const idField =
    names.find((n) => lc(n) === "tournamentid") ||
    names.find((n) => lc(n) === "tournament_id") ||
    names.find((n) => lc(n) === "id");

  const minField =
    names.find((n) => ["minlevel", "min_level", "minherolevel", "min_hero_level"].includes(lc(n))) ||
    names.find((n) => lc(n).includes("min") && lc(n).includes("level"));

  const maxField =
    names.find((n) => ["maxlevel", "max_level", "maxherolevel", "max_hero_level"].includes(lc(n))) ||
    names.find((n) => lc(n).includes("max") && lc(n).includes("level"));

  return { idField, minField, maxField };
}

function tierFromMinMax(minL, maxL) {
  if (!Number.isFinite(minL) || !Number.isFinite(maxL)) return null;
  return maxL >= 16 ? 20 : 10;
}

async function main() {
  const lb = readJson(LEADERBOARD_JSON);
  const wins = Array.isArray(lb.wins) ? lb.wins : [];
  const ids = [...new Set(wins.map((w) => String(w.tournamentId ?? "")).filter(Boolean))];
  ids.sort((a, b) => Number(a) - Number(b));

  console.log(`Loaded wins: ${wins.length}`);
  console.log(`Unique tournamentIds: ${ids.length}`);
  console.log(`Subgraph endpoint: ${SUBGRAPH_URL}`);

  const schema = await gql(INTROSPECTION);
  const candidates = pickTournamentListQueries(schema);

  if (!candidates.length) {
    throw new Error("Could not find any query field containing 'tournament' that returns an object list.");
  }

  // Try candidates until one exposes min/max level fields.
  let chosen = null;
  for (const c of candidates) {
    const typeDef = schema.__schema.types.find((t) => t.name === c.objectType);
    const { idField, minField, maxField } = findLevelFields(typeDef);
    if (idField && minField && maxField) {
      chosen = { ...c, idField, minField, maxField };
      break;
    }
  }

  if (!chosen) {
    const names = candidates.map((c) => `${c.fieldName}:${c.objectType}`).join(", ");
    throw new Error(
      `Found tournament-ish list queries (${names}) but none had min/max level fields in their return type.`
    );
  }

  console.log(
    `Using query field '${chosen.fieldName}' (${chosen.objectType}) with fields: ${chosen.idField}, ${chosen.minField}, ${chosen.maxField}`
  );

  // Query in chunks. We try a few query shapes because subgraphs differ:
  // - some use 'where: { tournamentId_in: [...] }'
  // - some use 'where: { id_in: [...] }'
  // We'll attempt both.
  const results = {};
  const CHUNK = 200;

  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunkIds = ids.slice(i, i + CHUNK);
    console.log(`Fetching ${i + 1}-${Math.min(i + CHUNK, ids.length)} / ${ids.length}`);

    const qWhereTournamentIdIn = `
      query R($ids: [String!]) {
        ${chosen.fieldName}(first: ${CHUNK}, where: { tournamentId_in: $ids }) {
          ${chosen.idField}
          ${chosen.minField}
          ${chosen.maxField}
        }
      }`;

    const qWhereIdIn = `
      query R($ids: [String!]) {
        ${chosen.fieldName}(first: ${CHUNK}, where: { id_in: $ids }) {
          ${chosen.idField}
          ${chosen.minField}
          ${chosen.maxField}
        }
      }`;

    let rows = null;
    try {
      const data = await gql(qWhereTournamentIdIn, { ids: chunkIds });
      rows = data?.[chosen.fieldName] || null;
    } catch (e) {
      // ignore and try next shape
    }

    if (!rows) {
      const data = await gql(qWhereIdIn, { ids: chunkIds });
      rows = data?.[chosen.fieldName] || [];
    }

    for (const r of rows) {
      const tidRaw = r[chosen.idField];
      const tid = String(tidRaw);
      const minL = Number(r[chosen.minField]);
      const maxL = Number(r[chosen.maxField]);
      const tier = tierFromMinMax(minL, maxL);
      results[tid] = { minLevel: minL, maxLevel: maxL, tier, source: "subgraph" };
    }
  }

  // If the subgraph doesn't return everything (pagination/where limits),
  // keep whatever we got and report missing.
  const missing = ids.filter((id) => !results[id]);
  console.log(`Resolved ranges: ${Object.keys(results).length}/${ids.length}`);
  if (missing.length) console.log(`Missing range entries: ${missing.length} (example: ${missing.slice(0, 10).join(", ")})`);

  writeJson(OUT_RANGES_JSON, results);
  console.log(`Wrote ${OUT_RANGES_JSON}`);
}

main().catch((e) => {
  console.error("ERROR:", e.message || e);
  process.exitCode = 1;
});
