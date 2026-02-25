#!/usr/bin/env node
/**
 * Probe the subgraph Query fields via __type(name:"Query").
 *
 * Requires:
 *   SUBGRAPH_URL env var or scripts/.env
 *
 * Usage:
 *   node scripts/probe-query-fields.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = val;
  }
}
loadDotEnv();

const SUBGRAPH_URL = process.env.SUBGRAPH_URL;

async function gql(query, variables) {
  const res = await fetch(SUBGRAPH_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Non-JSON response (${res.status}): ${text.slice(0, 500)}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json, null, 2).slice(0, 1600)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2).slice(0, 2000)}`);
  return json.data;
}

function unwrapNamedType(type) {
  let t = type;
  while (t && t.ofType) t = t.ofType;
  return t?.name || null;
}

function typeChain(type) {
  const parts = [];
  let t = type;
  while (t) {
    parts.push(`${t.kind}${t.name ? `(${t.name})` : ""}`);
    t = t.ofType;
  }
  return parts.join(" -> ");
}

async function main() {
  if (!SUBGRAPH_URL) {
    console.error("❌ Missing SUBGRAPH_URL.");
    console.error('Windows CMD example:\n  set SUBGRAPH_URL=https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7');
    console.error('Or create scripts/.env with:\n  SUBGRAPH_URL=https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7');
    process.exitCode = 1;
    return;
  }

  const q = `
    query($name: String!) {
      __type(name: $name) {
        name
        fields {
          name
          args { name type { kind name ofType { kind name ofType { kind name } } } }
          type { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  `;

  const data = await gql(q, { name: "Query" });
  const fields = data?.__type?.fields;

  if (!Array.isArray(fields) || fields.length === 0) {
    console.error("❌ Could not retrieve Query fields via __type.");
    process.exitCode = 1;
    return;
  }

  console.log(`Query fields (${fields.length}):`);
  for (const f of fields) {
    const named = unwrapNamedType(f.type);
    const args = (f.args || []).map((a) => a.name).join(", ");
    console.log(`- ${f.name}(${args}) : ${named || "unknown"} | ${typeChain(f.type)}`);
  }

  const interesting = fields
    .filter((f) => /tournament|range|level|tier|config|meta/i.test(f.name))
    .map((f) => f.name);

  console.log("\nLikely relevant Query fields (name contains tournament/range/level/tier/config/meta):");
  console.log(interesting.length ? interesting.map((s) => `- ${s}`).join("\n") : "- (none found by name filter)");

  process.exitCode = 0;
}

main().catch((e) => {
  console.error("❌ " + (e?.message ? e.message : String(e)));
  process.exitCode = 1;
});