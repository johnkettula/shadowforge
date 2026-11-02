# Stops the agent pipeline's LIVE copy of vm-intent: whatever is listening on its ports
# (18080 API, 18081 Temporal, 18082 Temporal UI, 18083 database, 18084-18085), plus its embedded
# Postgres. Nothing else is touched. The pipeline's next live deploy starts it again.
$ports = 18080..18085
$found = $false
$pids = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $ports -contains $_.LocalPort } |
  Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) {
  $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
  if ($proc) {
    $found = $true
    "stopping $($proc.ProcessName) (pid $p)"
    Stop-Process -Id $p -Force
  }
}
$pidFile = Join-Path $env:USERPROFILE 'agent-pipeline-home\state\live\pgdata\postmaster.pid'
if (Test-Path $pidFile) {
  $pg = [int](Get-Content $pidFile -TotalCount 1)
  $proc = Get-Process -Id $pg -ErrorAction SilentlyContinue
  if ($proc -and $proc.ProcessName -like 'postgres*') {
    $found = $true
    "stopping postgres (pid $pg)"
    Stop-Process -Id $pg -Force
  }
}
if (-not $found) { 'nothing was running on the live ports' }
Start-Sleep -Seconds 2
$still = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $ports -contains $_.LocalPort }
if ($still) { 'STILL LISTENING: ' + (($still | ForEach-Object { "$($_.LocalPort)/pid $($_.OwningProcess)" }) -join ', ') } else { 'live ports are free' }
