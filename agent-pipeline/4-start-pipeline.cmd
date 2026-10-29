@echo off
REM Starts the pipeline for real: Claude agents, merges and pushes to GitHub on their own.
REM It runs until you stop it (5-control.cmd stop), within the limits in pipeline.config.json.
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
call npm run ctl -- start
pause
