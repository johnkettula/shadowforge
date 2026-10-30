@echo off
REM Checks the Anthropic API key in settings.cmd with one free call (list models).
REM Writes only the outcome to check-key.txt, never the key.
cd /d "%~dp0"
if exist settings.cmd call settings.cmd
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$k=$env:ANTHROPIC_API_KEY; if (-not $k) { 'NO KEY: ANTHROPIC_API_KEY is empty in settings.cmd'; exit }" ^
  "'key starts with: ' + $k.Substring(0, [Math]::Min(10, $k.Length)) + '... (' + $k.Length + ' characters)';" ^
  "try { $r = Invoke-WebRequest -UseBasicParsing -Uri 'https://api.anthropic.com/v1/models' -Headers @{ 'x-api-key' = $k; 'anthropic-version' = '2023-06-01' };" ^
  "  'OK: the API accepted the key (HTTP ' + $r.StatusCode + ')' }" ^
  "catch { $s = $_.Exception.Response.StatusCode.value__; 'FAILED: HTTP ' + $s + ' ' + $_.ErrorDetails.Message }" > check-key.txt 2>&1
type check-key.txt
