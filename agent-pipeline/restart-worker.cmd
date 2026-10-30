@echo off
REM Stops the running pipeline worker (the node process running src\worker.ts) and starts a new one,
REM so it picks up changed code. A cycle that was running carries on in the new worker.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'src[\\/]worker\.ts' } | ForEach-Object { 'stopping worker ' + $_.ProcessId; Stop-Process -Id $_.ProcessId -Force }"
timeout /t 2 /nobreak >nul
call "%~dp02-start-worker.cmd"
