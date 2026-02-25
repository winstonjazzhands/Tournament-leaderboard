import fs from "node:fs";
import path from "node:path";

const GRAPHQL = process.env.DFK_PROFILE_GRAPHQL || "https://api.defikingdoms.com/graphql";

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2), "utf8");
}

function uniq(arr) {
  return [...new Set(arr)];
}

async function gql(query, variables) {
  const res = await fetch(GRAPHQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.errors) {
    const msg =
      json?.errors?.[0]?.message ||
      `HTTP ${res.status} ${res.statusText}`;
    throw new Error(msg);
  }
  return json.data;
}

function pickLeaderboardPath() {
  const cwd = process.cwd();
  const c1 = path.join(cwd, "public", "leaderboard.json");
  const c2 = path.join(cwd, "leaderboard.json");
  if (fs.existsSync(c1)) return c1;
  return c2;
}

function loadWalletsFromLeaderboard(leaderboardPath) {
  const data = readJson(leaderboardPath);
  const wins = Array.isArray(data?.wins) ? data.wins : [];
  const wallets = wins
    .map((w) => (w.wallet || "").toLowerCase())
    .filter((w) => w && w.startsWith("0x") && w.length === 42);
  return uniq(wallets);
}

async function main() {
  const leaderboardPath = pickLeaderboardPath();
  const publicDir = path.join(process.cwd(), "public");
  const profilesPath = path.join(publicDir, "profiles.json");

  const wallets = loadWalletsFromLeaderboard(leaderboardPath);
  console.log(`Loaded wallets: ${wallets.length}`);

  const cache = readJson(profilesPath) || {};
  const namesByAddress = (cache.namesByAddress && typeof cache.namesByAddress === "object")
    ? { ...cache.namesByAddress }
    : {};

  const missing = wallets.filter((w) => !namesByAddress[w]);
  console.log(`Cache has ${Object.keys(namesByAddress).length} entries.`);
  console.log(`Missing names to resolve: ${missing.length}`);

  if (!missing.length) {
    const out = {
      updatedAtUtc: new Date().toISOString(),
      source: "dfk-graphql-profiles",
      graphql: GRAPHQL,
      namesByAddress,
    };
    writeJson(profilesPath, out);
    console.log(`Wrote ${profilesPath}`);
    console.log("Done. Resolved 0 new.");
    return;
  }

  const query = `
    query Profiles($ids: [String!]!) {
      profiles(where: { id_in: $ids }) {
        id
        name
      }
    }
  `;

  const BATCH = 150;
  let newly = 0;

  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = missing.slice(i, i + BATCH);
    console.log(`Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(missing.length / BATCH)} | requested=${batch.length}`);

    const data = await gql(query, { ids: batch });
    const rows = Array.isArray(data?.profiles) ? data.profiles : [];

    for (const r of rows) {
      const id = (r?.id || "").toLowerCase();
      const name = (r?.name || "").trim();
      if (!id || !name) continue;
      if (!namesByAddress[id]) newly++;
      namesByAddress[id] = name;
    }
  }

  const out = {
    updatedAtUtc: new Date().toISOString(),
    source: "dfk-graphql-profiles",
    graphql: GRAPHQL,
    namesByAddress,
  };

  writeJson(profilesPath, out);
  console.log(`Wrote ${profilesPath}`);
  console.log(`Done. Resolved ${Object.keys(namesByAddress).length}/${wallets.length} (new this run: ${newly}).`);
}

main().catch((e) => {
  console.error("ERROR:", e?.message || e);
  process.exitCode = 1;
});
