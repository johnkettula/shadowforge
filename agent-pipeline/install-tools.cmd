@echo off
REM Installs what the pipeline needs that basement doesn't have, without admin rights:
REM   - Portable Git 2.56.0 into %USERPROFILE%\tools\git (checksum and signature checked first)
REM   - the Python packages the API contract test uses (openapi-core, requests)
REM Writes install-tools.log. Safe to run again.
cd /d "%~dp0"
set GITDIR=%USERPROFILE%\tools\git
echo started %DATE% %TIME% > install-tools.log
if exist "%GITDIR%\cmd\git.exe" (
  echo Git already in %GITDIR% >> install-tools.log
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -Command ^
    "$ErrorActionPreference='Stop';" ^
    "$url='https://github.com/git-for-windows/git/releases/download/v2.56.0.windows.4/PortableGit-2.56.0.4-64-bit.7z.exe';" ^
    "$f=Join-Path $env:TEMP 'PortableGit-2.56.0.4-64-bit.7z.exe';" ^
    "Invoke-WebRequest -UseBasicParsing $url -OutFile $f;" ^
    "$h=(Get-FileHash $f -Algorithm SHA256).Hash;" ^
    "if ($h -ne 'B1F3E52216E2ED6882D1BEBFD4D3FDF319BEC40D2EDBBF9FD26EC4FD3FCE7ED1') { throw ('checksum mismatch: ' + $h) };" ^
    "$sig=Get-AuthenticodeSignature $f; 'signature: ' + $sig.Status + ' ' + $sig.SignerCertificate.Subject;" ^
    "if ($sig.Status -ne 'Valid') { throw 'the download is not validly signed' };" ^
    "Start-Process -FilePath $f -ArgumentList @('-y', ('-o' + $env:USERPROFILE + '\tools\git')) -Wait;" ^
    "Remove-Item $f; 'Git unpacked'" >> install-tools.log 2>&1
)
"%GITDIR%\cmd\git.exe" --version >> install-tools.log 2>&1
python -m pip install --user --quiet openapi-core requests >> install-tools.log 2>&1
python -c "import openapi_core, requests; print('python packages ok')" >> install-tools.log 2>&1
echo finished %DATE% %TIME% >> install-tools.log
type install-tools.log
