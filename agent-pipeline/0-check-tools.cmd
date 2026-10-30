@echo off
REM Lists the tools the pipeline needs and their versions, into check-tools.txt (and on screen).
cd /d "%~dp0"
(
  echo checked %DATE% %TIME%
  for %%t in (git node npm java mvn python temporal docker claude) do (
    echo.
    echo == %%t
    where %%t 2^>^&1
  )
  echo.
  echo == versions
  git --version 2>&1
  node --version 2>&1
  java -version 2>&1
  call mvn -v 2>&1 | findstr /b "Apache"
  python --version 2>&1
  temporal --version 2>&1
  docker --version 2>&1
  python -c "import openapi_core, requests; print('python packages: ok')" 2>&1
) > check-tools.txt
type check-tools.txt
