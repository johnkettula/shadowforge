@echo off
rem Starts OpenCode in server mode on http://127.0.0.1:4096, in your clone qwen-work, so Claude can
rem send it prompts through the browser pane. Close this window to stop it.
set "PATH=%USERPROFILE%\tools\git\cmd;%USERPROFILE%\tools\node-v24.20.0-win-x64;%PATH%"
cd /d "%USERPROFILE%\qwen-work"
title OpenCode server (qwen-work, port 4096)
opencode serve --port 4096 --hostname 127.0.0.1
pause
