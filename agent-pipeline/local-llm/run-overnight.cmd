@echo off
rem Double-click to let OpenCode + local Qwen work through overnight-tasks.json in qwen-work.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-overnight.ps1"
echo.
echo Finished. See overnight\summary.txt
pause
