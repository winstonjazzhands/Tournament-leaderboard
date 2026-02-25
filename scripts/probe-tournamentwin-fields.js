#!/usr/bin/env node
/**
 * Probe the subgraph for the fields on the TournamentWin type.
 *
 * Requires:
 *   SUBGRAPH_URL set (env var or scripts/.env)
 *
 * Usage:
 *   node scripts/probe-tournamentwin-fields.js
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// tiny .env loader (no deps)
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
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(json, null, 2).slice(0, 1200)}`);
  if (json.errors?.length) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors, null, 2).slice(0, 2000)}`);
  return json.data;
}

function unwrapNamedType(type) {
  let t = type;
  while (t && t.ofType) t = t.ofType;
  return t?.name || null;
}

async function main() {
  if (!SUBGRAPH_URL) {
    console.error("❌ Missing SUBGRAPH_URL.");
    console.error('Set it with: set SUBGRAPH_URL=https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7');
    console.error('Or create scripts/.env with: SUBGRAPH_URL=https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7');
    process.exitCode = 1;
    return;
  }

  // Try __type first (often allowed even when __schema is blocked)
  const typeQuery = `
    query($name: String!) {
      __type(name: $name) {
        name
        fields {
          name
          type { kind name ofType { kind name ofType { kind name } } }
        }
      }
    }
  `;

  let typeData = null;
  try {
    typeData = await gql(typeQuery, { name: "TournamentWin" });
  } catch (e) {
    console.error("❌ __type probe failed.");
    console.error(String(e?.message || e));
  }

  if (!typeData?.__type?.fields?.length) {
    console.log("\nCould not retrieve TournamentWin fields via __type.");
    console.log("Next best option: run your existing probe script (the one that printed Query fields containing 'win') and paste the output.");
    process.exitCode = 1;
    return;
  }

  const fields = typeData.__type.fields.map((f) => ({
    name: f.name,
    namedType: unwrapNamedType(f.type),
  }));

  console.log("TournamentWin fields:");
  for (const f of fields) {
    console.log(`- ${f.name} : ${f.namedType || "unknown"}`);
  }

  // Also try to see if there is a Tournament-like type referenced
  const likelyRefs = fields
    .filter((f) => f.namedType && f.namedType.toLowerCase().includes("tournament"))
    .map((f) => `${f.name} -> ${f.namedType}`);

  if (likelyRefs.length) {
    console.log("\nTournament-related references from TournamentWin:");
    for (const r of likelyRefs) console.log(`- ${r}`);
  } else {
    console.log("\nNo tournament-like reference fields detected on TournamentWin.");
  }

  process.exitCode = 0;
}

main();