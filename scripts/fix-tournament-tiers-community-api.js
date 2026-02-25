/**
 * fix-tournament-tiers-community-api.js (ESM)
 *
 * Goal:
 *   Build/refresh public/tournamentRanges.json as:
 *     tournamentId -> { minLevel, maxLevel }
 *
 * Usage:
 *   node scripts/fix-tournament-tiers-community-api.js
 *
 * Env overrides (optional):
 *   DFK_TOURNAMENT_DETAILS_ENDPOINTS="https://.../graphql,https://.../graphql"
 *
 * Notes:
 *   - This script tries several query shapes because DFK community schemas have varied over time.
 *   - Once tournamentRanges.json exists, the HTML can correctly classify tier 10 vs 20 by maxLevel > 10.
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const ROOT = process.cwd();
const PUBLIC_DIR = path.join(ROOT, "public");
const WINS_PATH = path.join(PUBLIC_DIR, "leaderboard.json");
const OUT_PATH = path.join(PUBLIC_DIR, "tournamentRanges.json");

// Public community GraphQL gateway (referenced publicly). :contentReference[oaicite:1]{index=1}
const DEFAULT_ENDPOINTS = [
  "https://defi-kingdoms-community-api-gateway-co06z8vi.uc.gateway.dev/graphql",
];

function readJsonIfExists(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function uniq(arr) {
  return [...new Set(arr)];
}

function toInt(x) {
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
}

function normalizeTournamentId(x) {
  if (x == null) return null;
  const s = String(x).trim();
  if (!s) return null;
  // you said they’re sequential numeric ids — keep digits
  const m = s.match(/\d+/);
  return m ? m[0] : s;
}

async function gql(endpoint, query, variables) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${res.status} ${res.statusText} :: Non-JSON response: ${text.slice(0, 250)}`);
  }
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} :: ${text.slice(0, 500)}`);
  }
  if (json.errors && json.errors.length) {
    throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 800)}`);
  }
  return json.data;
}

/**
 * Try a handful of likely tournament list queries.
 * We accept any result item that contains:
 *   id-like field + minLevel/maxLevel-like fields
 */
const QUERY_VARIANTS = [
  // Variant A: common "tournaments(where:{id_in:[...]})"
  {
    name: "tournaments(where:{id_in})",
    query: `
      query ($ids: [String!]!) {
        tournaments(where: { id_in: $ids }) {
          id
          minLevel
          maxLevel
        }
      }
    `,
    pick: (data) => data?.tournaments,
  },

  // Variant B: id as Int
  {
    name: "tournaments(where:{id_in:Int})",
    query: `
      query ($ids: [Int!]!) {
        tournaments(where: { id_in: $ids }) {
          id
          minLevel
          maxLevel
        }
      }
    `,
    pick: (data) => data?.tournaments,
  },

  // Variant C: "tournamentDetails" style
  {
    name: "tournamentDetails(ids)",
    query: `
      query ($ids: [String!]!) {
        tournamentDetails(ids: $ids) {
          id
          minLevel
          maxLevel
        }
      }
    `,
    pick: (data) => data?.tournamentDetails,
  },

  // Variant D: "tournament" single lookup (slower; we can fall back to batching one-by-one)
  {
    name: "tournament(id)",
    query: `
      query ($id: String!) {
        tournament(id: $id) {
          id
          minLevel
          maxLevel
        }
      }
    `,
    pickSingle: (data) => data?.tournament ? [data.tournament] : [],
  },
];

function coerceRangeItem(item) {
  if (!item || typeof item !== "object") return null;

  const id =
    normalizeTournamentId(item.id ?? item.tournamentId ?? item.tourneyId ?? item._id);

  const minLevel =
    toInt(item.minLevel ?? item.min_level ?? item.levelMin ?? item.minLvl ?? item.min_level_req);

  const maxLevel =
    toInt(item.maxLevel ?? item.max_level ?? item.levelMax ?? item.maxLvl ?? item.max_level_req);

  if (!id) return null;
  if (minLevel == null && maxLevel == null) return null;

  return { id, minLevel, maxLevel };
}

async function tryFetchBatch(endpoint, ids) {
  // Try list/batch variants first
  for (const v of QUERY_VARIANTS) {
    if (v.pick) {
      try {
        const variables = v.name.includes("Int")
          ? { ids: ids.map((x) => Number(x)).filter(Number.isFinite) }
          : { ids };

        // If ints variant but nothing valid, skip
        if (v.name.includes("Int") && variables.ids.length === 0) continue;

        const data = await gql(endpoint, v.query, variables);
        const items = v.pick(data) || [];
        const ranges = items.map(coerceRangeItem).filter(Boolean);

        // If it returned at least 1 range, treat as success
        if (ranges.length > 0) {
          return { mode: v.name, ranges };
        }
      } catch (e) {
        // keep trying next variant
      }
    }
  }

  // Fallback: single lookups
  const singleVariant = QUERY_VARIANTS.find((x) => x.pickSingle);
  if (!singleVariant) return null;

  const ranges = [];
  for (const id of ids) {
    try {
      const data = await gql(endpoint, singleVariant.query, { id });
      const items = singleVariant.pickSingle(data) || [];
      const r = items.map(coerceRangeItem).filter(Boolean);
      if (r.length) ranges.push(...r);
    } catch {
      // ignore per-id errors; we’re best-effort
    }
  }
  if (ranges.length) return { mode: singleVariant.name, ranges };

  return null;
}

function buildEndpointCandidates() {
  const env = process.env.DFK_TOURNAMENT_DETAILS_ENDPOINTS || process.env.DFK_TOURNAMENT_DETAILS_ENDPOINT;
  if (!env) return DEFAULT_ENDPOINTS;
  return env.split(",").map((s) => s.trim()).filter(Boolean);
}

async function main() {
  if (!fs.existsSync(WINS_PATH)) {
    console.error(`Missing ${WINS_PATH}. Put your leaderboard.json in public/.`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(WINS_PATH, "utf8"));
  const wins = Array.isArray(raw.wins) ? raw.wins : [];

  const ids = uniq(
    wins
      .map((w) => normalizeTournamentId(w.tournamentId ?? w.tourneyId ?? w.id))
      .filter(Boolean)
  ).sort((a, b) => Number(a) - Number(b));

  console.log(`Loaded wins: ${wins.length}`);
  console.log(`Unique tournamentIds: ${ids.length}`);

  const existing = readJsonIfExists(OUT_PATH, {
    updatedAtUtc: null,
    source: null,
    rangesByTournamentId: {},
  });

  const existingMap = existing?.rangesByTournamentId && typeof existing.rangesByTournamentId === "object"
    ? existing.rangesByTournamentId
    : {};

  const missing = ids.filter((id) => !existingMap[id]);
  console.log(`Cache entries: ${Object.keys(existingMap).length}`);
  console.log(`Missing tournament ranges: ${missing.length}`);

  if (missing.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  const endpoints = buildEndpointCandidates();
  let lastErr = null;

  // Batch sizes: start big, but not absurd
  const BATCH = 100;

  for (const endpoint of endpoints) {
    console.log(`Trying endpoint: ${endpoint}`);

    // Copy map so partial successes persist if endpoint works halfway
    const map = { ...existingMap };
    let resolved = 0;

    try {
      for (let i = 0; i < missing.length; i += BATCH) {
        const slice = missing.slice(i, i + BATCH);
        const result = await tryFetchBatch(endpoint, slice);

        if (!result) {
          throw new Error(`No compatible tournament query worked against ${endpoint}`);
        }

        for (const r of result.ranges) {
          if (!r?.id) continue;
          map[r.id] = { minLevel: r.minLevel, maxLevel: r.maxLevel };
        }

        resolved = Object.keys(map).length;
        console.log(
          `Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(missing.length / BATCH)} ` +
          `| mode=${result.mode} | cached=${resolved}/${ids.length}`
        );
      }

      const out = {
        updatedAtUtc: new Date().toISOString(),
        source: endpoint,
        rangesByTournamentId: map,
      };
      writeJson(OUT_PATH, out);

      console.log(`Wrote ${OUT_PATH}`);
      console.log(`Done. Cached ranges: ${Object.keys(map).length}/${ids.length}`);
      return; // success
    } catch (e) {
      lastErr = e;
      console.log(`Endpoint failed: ${endpoint}`);
      console.log(`  ${String(e?.message || e)}`);
      // try next endpoint
    }
  }

  console.error("ERROR: Unable to fetch tournament ranges from any candidate endpoint.");
  if (lastErr) console.error(`Last error: ${String(lastErr.message || lastErr)}`);
  console.error(
    "If you know a working endpoint, set DFK_TOURNAMENT_DETAILS_ENDPOINTS as a comma-separated list."
  );
  process.exit(1);
}

main().catch((e) => {
  console.error(String(e?.stack || e));
  process.exit(1);
});