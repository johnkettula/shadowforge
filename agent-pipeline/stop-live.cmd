@echo off
REM Stops the agent pipeline's live copy of vm-intent (ports 18080-18085). See stop-live.ps1.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-live.ps1" > "%~dp0stop-live.txt" 2>&1
type "%~dp0stop-live.txt"
