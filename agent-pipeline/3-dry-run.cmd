@echo off
REM One cycle with scripted agents (no AI, no cost) that changes a docs file, to check that
REM cloning, building, staging, the checks and merging all work on this PC. Nothing is pushed.
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
set AGENT_PIPELINE_AGENT=scripted
set AGENT_PIPELINE_PUSH=false
set AGENT_PIPELINE_HOME=%USERPROFILE%\agent-pipeline-dryrun
set AGENT_PIPELINE_PORT_OFFSET=500
call npm run ctl -- once
echo.
echo Reports: %AGENT_PIPELINE_HOME%\reports
pause
