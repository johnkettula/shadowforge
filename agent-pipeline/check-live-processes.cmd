@echo off
REM Read-only: lists the processes using the live deploy's folder, into check-live-processes.txt.
cd /d "%~dp0"
call node_modules\.bin\tsx.cmd scripts\check-live-processes.ts > check-live-processes.txt 2>&1
type check-live-processes.txt
timeout /t 5 >nul
