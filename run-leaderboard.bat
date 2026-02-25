@echo off
setlocal

REM ==========================================
REM DFK Tournament Leaderboard - One-click run
REM ==========================================

REM 1) Go to project folder
cd /d C:\Users\whilu\tournament-leaderboard
if errorlevel 1 (
  echo [ERROR] Could not cd to project folder.
  pause
  exit /b 1
)

REM 2) Environment (RPC + seed txs)
set RPC_URL=https://andromeda.metis.io/?owner=1088
set SEED_TX_L10=0x7c410f9faf35cae21b23d1ff35495237e82d500e5845e96fca361d71a9e78820
set SEED_TX_L20=0x216dfd59fedd6b85bbc9548fdab5339e5f5a6f89b753cc196035b1ec80679edb

echo ==========================================
echo DFK Tournament Leaderboard Runner
echo Folder: %CD%
echo RPC_URL: %RPC_URL%
echo ==========================================
echo.

REM 3) Build profiles cache
echo [1/4] Updating profiles.json (name cache)...
node scripts\resolve-profiles-community-api.js
if errorlevel 1 (
  echo.
  echo [ERROR] resolve-profiles-community-api.js failed.
  pause
  exit /b 1
)
echo.

REM 4) Build tournament ranges cache
echo [2/4] Updating tournamentRanges.json (tier overrides)...
node scripts\build-tournamentRanges-subgraph.js
if errorlevel 1 (
  echo.
  echo [ERROR] build-tournamentRanges-subgraph.js failed.
  pause
  exit /b 1
)
echo.

REM 5) Validate outputs
echo [3/4] Validating public data...
node scripts\validate-public-data.js
if errorlevel 1 (
  echo.
  echo [ERROR] validate-public-data.js reported issues.
  pause
  exit /b 1
)
echo.

REM 6) Launch local server
echo [4/4] Launching local server on http://localhost:8080/
echo (Close this window or press Ctrl+C to stop the server.)
echo.

REM Use npx so user doesn't need a global install
npx http-server public -p 8080 -c-1

endlocal