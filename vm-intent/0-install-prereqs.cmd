@echo off
REM Installs Java 21, Node.js, Maven and the Temporal CLI.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-prereqs.ps1"
pause
