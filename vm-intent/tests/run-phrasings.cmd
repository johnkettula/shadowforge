@echo off
REM Runs all test phrasings (2,300) against the running backend (start 2-start-backend.cmd first).
cd /d "%~dp0.."
node tests\run-phrasings.mjs phrasings.json
node tests\run-phrasings.mjs phrasings-holdout.json
node tests\run-phrasings.mjs phrasings-set3.json
node tests\run-phrasings.mjs phrasings-gen-s1.json
node tests\run-phrasings.mjs phrasings-gen-s2.json
pause
