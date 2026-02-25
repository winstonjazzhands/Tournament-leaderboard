Tournament Leaderboard — One-command runner
==========================================

This project is a The Graph subgraph.

Run everything in the correct order with ONE command:

macOS / Linux:
  ./runner/start.sh

Windows:
  runner\start.bat

Requirements
------------
- Docker Desktop / Docker Engine with docker compose
- Node.js (18+ recommended)

RPC endpoint (important)
------------------------
Your graph-node container needs an Ethereum JSON-RPC endpoint.
By default this project points to:
  mainnet:http://host.docker.internal:8545

If you don't have an RPC node running there, set ETHEREUM_RPC first:

macOS/Linux:
  export ETHEREUM_RPC="mainnet:https://YOUR_RPC_URL"
  ./runner/start.sh

Windows (PowerShell):
  setx ETHEREUM_RPC "mainnet:https://YOUR_RPC_URL"
  runner\start.bat

Stop services:
  ./runner/stop.sh   (macOS/Linux)
  runner\stop.bat   (Windows)

After start, your subgraph should be queryable at:
  http://localhost:8000/subgraphs/name/tournament-leaderboard
