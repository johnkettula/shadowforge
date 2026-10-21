@echo off
REM Starts the React UI on http://localhost:5173
cd /d "%~dp0frontend"
if not exist node_modules call npm install
npm run dev
