\
    @echo off
    setlocal enabledelayedexpansion
    cd /d %~dp0\..

    echo == Tournament Leaderboard local runner ==

    > docker-compose.override.yml (
      echo version: "3"
      echo services:
      echo   graph-node:
      echo     environment:
      echo       ethereum: "${ETHEREUM_RPC:-mainnet:http://host.docker.internal:8545}"
    )

    echo 1^) Starting docker services...
    docker compose up -d
    if errorlevel 1 goto :err

    echo 2^) Installing Node deps...
    if exist package-lock.json (
      npm ci
    ) else (
      npm install
    )
    if errorlevel 1 goto :err

    echo 3^) Codegen + build...
    npx graph codegen
    if errorlevel 1 goto :err
    npx graph build
    if errorlevel 1 goto :err

    echo 4^) Create subgraph (ok if already exists)...
    npx graph create --node http://localhost:8020/ tournament-leaderboard

    echo 5^) Deploy subgraph...
    npx graph deploy --node http://localhost:8020/ --ipfs http://localhost:5001 tournament-leaderboard
    if errorlevel 1 goto :err

    echo Done.
    echo GraphQL: http://localhost:8000/subgraphs/name/tournament-leaderboard
    exit /b 0

    :err
    echo ERROR: A step failed. Check output above.
    exit /b 1
