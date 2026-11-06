@echo off
REM   5-control status | approve [note] | skip [reason] | reject [reason] | pause [reason] | resume | run-now | stop | synopsis [days] | deploy-live | reports
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
call npm run --silent ctl -- %*
