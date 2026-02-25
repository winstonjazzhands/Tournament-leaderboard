/**
 * update-all.js
 * Runs your update steps in order.
 * IMPORTANT: This file is ESM (because scripts/package.json has "type":"module").
 *
 * Behavior:
 *  - Always updates wins (leaderboard.json) first.
 *  - Attempts profiles + tournamentRanges, but does NOT crash the whole run if one of those fails.
 *  - Runs validation at the end.
 */

import { spawn } from "node:child_process";

function run(cmd, args = [], opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: "inherit", shell: false, ...opts });
    p.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (${code}): ${cmd} ${args.join(" ")}`));
    });
  });
}

async function runSoft(label, fn) {
  try {
    await fn();
    console.log(`✅ ${label} OK`);
    return true;
  } catch (e) {
    console.log(`⚠️ ${label} FAILED (continuing)`);
    console.log(String(e?.message || e));
    return false;
  }
}

async function main() {
  // 1) WINS (required)
  console.log("\n==============================");
  console.log("Step 1/4: Update wins");
  console.log("==============================\n");
  await run("node", ["scripts/pull-wins-tier-from-logs-post22m-lookback.js"]);

  // 2) PROFILES (soft)
  console.log("\n==============================");
  console.log("Step 2/4: Update profiles");
  console.log("==============================\n");
  await runSoft("profiles update", async () => {
    await run("node", ["scripts/resolve-profiles-community-api.js"]);
  });

  // 3) TOURNAMENT RANGES (soft but recommended)
  console.log("\n=======================================");
  console.log("Step 3/4: Update tournamentRanges.json");
  console.log("=======================================\n");

  const hasSeedL10 = !!process.env.SEED_TX_L10;
  const hasSeedL20 = !!process.env.SEED_TX_L20;

  if (!hasSeedL10 || !hasSeedL20) {
    console.log(
      "⚠️ Skipping tournamentRanges build because SEED_TX_L10 and/or SEED_TX_L20 is missing.\n" +
        "   Provide both env vars (GitHub Actions does this via the workflow env block)."
    );
  } else {
    await runSoft("tournamentRanges build", async () => {
      await run("node", ["scripts/build-tournamentRanges-subgraph.js"]);
    });
  }

  // 4) VALIDATE (soft)
  console.log("\n==============================");
  console.log("Step 4/4: Validate public data");
  console.log("==============================\n");

  await runSoft("validate public data", async () => {
    // Prefer .js if present; fallback to .cjs if needed.
    // (Your repo has both in some snapshots.)
    await run("node", ["scripts/validate-public-data.js"]);
  });

  console.log("\n✅ update:all finished.");
}

main().catch((e) => {
  console.error("\n❌ update-all failed hard (wins step likely failed).");
  console.error(String(e?.message || e));
  process.exit(1);
});