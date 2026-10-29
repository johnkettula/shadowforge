@echo off
REM   5-control status | pause [reason] | resume | run-now | stop | reports
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
call npm run --silent ctl -- %*
