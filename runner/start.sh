#!/usr/bin/env bash
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "== Tournament Leaderboard local runner =="

# Refresh override to allow ETHEREUM_RPC override without editing docker-compose.yml
cat > docker-compose.override.yml <<'YAML'
version: "3"
services:
  graph-node:
    environment:
      ethereum: "${ETHEREUM_RPC:-mainnet:http://host.docker.internal:8545}"
YAML

echo "1) Starting docker services..."
docker compose up -d

echo "2) Installing Node deps..."
if [ -f package-lock.json ]; then
  npm ci
else
  npm install
fi

echo "3) Codegen + build..."
npx graph codegen
npx graph build

echo "4) Create subgraph (ok if already exists)..."
set +e
npx graph create --node http://localhost:8020/ tournament-leaderboard
set -e

echo "5) Deploy subgraph..."
npx graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 tournament-leaderboard

echo "Done."
echo "GraphQL: http://localhost:8000/subgraphs/name/tournament-leaderboard"
