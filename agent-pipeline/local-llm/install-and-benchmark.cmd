@echo off
rem Installs Ollama (from ollama.com, via winget), downloads two Qwen models and benchmarks them on
rem real vm-intent pipeline steps. John approved these downloads on 2026-11-07:
rem   Ollama for Windows (~1 GB), qwen3.5:9b (~6.6 GB), qwen3.5:4b (~3.4 GB).
rem Results go to results.txt next to this file. Nothing in the repo is changed.
setlocal
cd /d "%~dp0"
set LOG=%~dp0install.log
echo [%date% %time%] start > "%LOG%"

set OLLAMA=%LOCALAPPDATA%\Programs\Ollama\ollama.exe
if exist "%OLLAMA%" goto have
echo Installing Ollama with winget...
winget install --id Ollama.Ollama -e --silent --accept-source-agreements --accept-package-agreements >> "%LOG%" 2>&1
if not exist "%OLLAMA%" (
  echo Ollama did not install. See install.log. >> "%LOG%"
  echo Ollama did not install. See install.log.
  pause
  exit /b 1
)
:have
echo Ollama: "%OLLAMA%" >> "%LOG%"
rem Make sure the server is running (the installer usually starts it).
powershell -NoProfile -Command "try { Invoke-RestMethod http://127.0.0.1:11434/api/version | Out-Null } catch { Start-Process -WindowStyle Minimized '%OLLAMA%' 'serve'; Start-Sleep 5 }"

echo Downloading qwen3.5:9b (about 6.6 GB)...
"%OLLAMA%" pull qwen3.5:9b >> "%LOG%" 2>&1
echo Downloading qwen3.5:4b (about 3.4 GB)...
"%OLLAMA%" pull qwen3.5:4b >> "%LOG%" 2>&1
"%OLLAMA%" list >> "%LOG%" 2>&1

echo Running the benchmark (this can take an hour or more on CPU)...
node benchmark.mjs qwen3.5:4b qwen3.5:9b >> "%LOG%" 2>&1
echo [%date% %time%] done >> "%LOG%"
echo Done. Results are in results.txt
