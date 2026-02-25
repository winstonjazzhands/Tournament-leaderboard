#!/usr/bin/env node
/**
 * Fix tier values inside public/tournamentRanges.json based on minLevel/maxLevel.
 * Rule:
 *   tier = 20 if maxLevel >= 20 else 10
 *
 * Usage:
 *   node scripts/fix-tournamentRanges-tier.js
 */

import fs from "fs";

const FP = "public/tournamentRanges.json";

function main() {
  if (!fs.existsSync(FP)) {
    console.error(`Missing ${FP}`);
    process.exitCode = 1;
    return;
  }

  const j = JSON.parse(fs.readFileSync(FP, "utf8"));
  const m = j.rangesByTournamentId;

  if (!m || typeof m !== "object") {
    console.error("tournamentRanges.json missing rangesByTournamentId object");
    process.exitCode = 1;
    return;
  }

  let changed = 0;
  for (const [tid, r] of Object.entries(m)) {
    if (!r || typeof r !== "object") continue;
    const maxLevel = Number(r.maxLevel);
    const newTier = maxLevel >= 20 ? 20 : 10;
    if (Number(r.tier) !== newTier) {
      r.tier = newTier;
      changed++;
    }
  }

  j.updatedAtUtc = new Date().toISOString();
  j.source = (j.source || "unknown") + "+tierFix";

  fs.writeFileSync(FP, JSON.stringify(j, null, 2) + "\n", "utf8");
  console.log(`Updated ${FP}. tier changes applied: ${changed}`);
}

main();