@echo off
REM Copy this file to settings.cmd (which git ignores) and fill it in. The other .cmd files read it.

REM Your Anthropic API key, from https://console.anthropic.com (Settings > API keys).
REM The agents use it; it is never passed to builds, tests or the vm-intent servers.
set ANTHROPIC_API_KEY=

REM Where the pipeline keeps its own copy of the repo, worktrees, logs and reports.
set AGENT_PIPELINE_HOME=%USERPROFILE%\agent-pipeline-home

REM The Temporal server the pipeline's workflows run on (the one from vm-intent\1-start-temporal.cmd).
set TEMPORAL_ADDRESS=127.0.0.1:7233

REM Full path to temporal.exe if it isn't on PATH (staging starts its own Temporal with it).
REM set TEMPORAL_CLI=C:\tools\temporal.exe
