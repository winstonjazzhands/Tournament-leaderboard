// scripts/profile-bouts-per-tournament.js

import fs from "fs";

const votes = JSON.parse(fs.readFileSync("public/votes.json","utf8"));

const perTournament = {};

for (const v of votes) {
  const t = v.tournamentId;
  const b = v.boutKey;
  perTournament[t] ??= new Set();
  perTournament[t].add(b);
}

for (const t of Object.keys(perTournament).sort((a,b)=>a-b)) {
  console.log(
    "Tournament",
    t,
    "unique boutKeys:",
    perTournament[t].size
  );
}