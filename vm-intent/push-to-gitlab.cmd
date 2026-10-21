@echo off
REM Pushes this project to a GitLab repository using Git on this PC.
REM Put the repo URL in gitlab-url.txt (one line), or paste it when asked.
setlocal
cd /d "%~dp0"
where git >nul 2>nul || (echo Git is not installed. Install it with:  winget install Git.Git & pause & exit /b 1)
set "REPO="
if exist gitlab-url.txt set /p REPO=<gitlab-url.txt
if "%REPO%"=="" set /p REPO=Paste your GitLab repo URL, e.g. https://gitlab.com/you/vm-intent.git : 
if not exist .git git init -b main
git config user.name >nul 2>nul || git config user.name "John Kettula"
git config user.email >nul 2>nul || set /p GITEMAIL=Email for Git commits: 
if defined GITEMAIL git config user.email "%GITEMAIL%"
git add -A
git commit -m "vm-intent: AI-driven VM provisioning on Temporal" -m "Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -m "Claude-Session: https://claude.ai/code/session_018rKNqiFJoTJXBV4bbojWq9"
git remote remove origin 2>nul
git remote add origin %REPO%
echo Pushing to %REPO% (a GitLab sign-in window may open)...
git push -u origin main
pause
