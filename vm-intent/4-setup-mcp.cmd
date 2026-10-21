@echo off
REM Builds the vm-intent MCP server and registers it (and GitLab MCP) with the Claude desktop app.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-mcp.ps1"
pause
