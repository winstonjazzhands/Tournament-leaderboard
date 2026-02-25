// scripts/resolve-profiles-from-subgraph.js
// Resolves wallet profile names from the Tournament Leaderboards subgraph

import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const SUBGRAPH =
  "https://api.studio.thegraph.com/query/1742426/tournament-leaderboards/1.7";

const ROOT = process.cwd();
const LEADERBOARD = path.join(ROOT, "public", "leaderboard.json");
const OUTPUT = path.join(ROOT, "public", "profiles.json");

async function graphQuery(query) {
  const res = await fetch(SUBGRAPH, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query })
  });

  const json = await res.json();
  if (json.errors) throw new Error(JSON.stringify(json.errors));
  return json.data;
}

async function main() {
  if (!fs.existsSync(LEADERBOARD)) {
    throw new Error("public/leaderboard.json not found.");
  }

  const raw = JSON.parse(fs.readFileSync(LEADERBOARD, "utf8"));
  const wins = Array.isArray(raw.wins) ? raw.wins : [];

  const walletSet = new Set();
  for (const w of wins) {
    if (w.wallet) walletSet.add(w.wallet.toLowerCase());
  }

  const wallets = [...walletSet];
  console.log(`Loaded ${wallets.length} wallets from leaderboard.`);

  const namesByAddress = {};

  // Query in chunks of 50
  for (let i = 0; i < wallets.length; i += 50) {
    const slice = wallets.slice(i, i + 50);

    const query = `
      {
        profiles(where: { id_in: [${slice.map(w => `"${w}"`).join(",")}] }) {
          id
          name
        }
      }
    `;

    const data = await graphQuery(query);
    const profiles = data.profiles || [];

    // Default null
    for (const w of slice) namesByAddress[w] = null;

    for (const p of profiles) {
      if (p.name && p.name.trim()) {
        namesByAddress[p.id.toLowerCase()] = p.name.trim();
      }
    }

    console.log(`Resolved ${Math.min(i + 50, wallets.length)}/${wallets.length}`);
  }

  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "subgraph",
    namesByAddress
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(out, null, 2));
  console.log(`Wrote ${OUTPUT}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});