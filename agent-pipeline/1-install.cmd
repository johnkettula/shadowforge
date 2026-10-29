@echo off
REM Installs the pipeline's packages. Run once, and again after pulling changes.
cd /d "%~dp0"
call npm install
if not exist settings.cmd copy settings.example.cmd settings.cmd >nul && echo Created settings.cmd: open it and add your API key.
if not exist pipeline.config.json copy pipeline.config.example.json pipeline.config.json >nul && echo Created pipeline.config.json: the pipeline's settings.
