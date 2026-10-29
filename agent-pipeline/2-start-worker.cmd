@echo off
REM Starts the pipeline's worker. Leave this window open while the pipeline runs.
REM Needs Temporal running first (vm-intent\1-start-temporal.cmd).
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
title agent pipeline worker
call npm run worker
