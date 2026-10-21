@echo off
REM Load test: asks for 2,000 VMs in one batch and watches them build (simulated clouds).
REM Needs 1-start-temporal.cmd and 2-start-backend.cmd running (and any 5-start-worker.cmd windows).
REM The report is saved in the loadtest folder.
cd /d "%~dp0"
title vm-intent load test
node loadtest\run-loadtest.mjs --count 2000 --shard 500 --fail 20 --out loadtest\report-basement.json
echo.
pause
