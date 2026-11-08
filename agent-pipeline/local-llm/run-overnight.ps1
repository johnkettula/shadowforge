# Runs OpenCode with the local Qwen (qwen3.5:4b through Ollama) on a list of small tasks, one at a
# time, in your own clone C:\Users\kettu\qwen-work (branch qwen/tests). It never touches the
# pipeline's folders, never runs mvn, and never pushes. Asked for by John on 2026-11-07.
# For each task it keeps only the file(s) the task is meant to create, commits them, and writes a log
# and a patch to Documents\agent-pipeline\local-llm\overnight\ for Claude to review in the morning.
$ErrorActionPreference = 'Continue'
$here   = Split-Path -Parent $MyInvocation.MyCommand.Path
$out    = Join-Path $here 'overnight'
$repo   = Join-Path $HOME 'qwen-work'
$tasks  = Get-Content (Join-Path $here 'overnight-tasks.json') -Raw | ConvertFrom-Json
$limit  = 45 * 60   # seconds per task
New-Item -ItemType Directory -Force $out | Out-Null
$summary = Join-Path $out 'summary.txt'
$env:Path = "$HOME\tools\git\cmd;$env:Path"
function Say($m) { $line = "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $m"; Write-Host $line; Add-Content $summary $line }

if (-not (Test-Path (Join-Path $repo '.git'))) { Say "No clone at $repo; stopping."; exit 1 }
$oc = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $oc) { Say 'The opencode command is not on PATH in this window; stopping (tell Claude where OpenCode is installed).'; exit 1 }
Say "OpenCode: $($oc.Source)"
Set-Location $repo
git checkout -q qwen/tests 2>$null; if ($LASTEXITCODE -ne 0) { git checkout -q -b qwen/tests }

# Project settings for OpenCode: the local model, and what it may do without asking (edit files,
# read-only git); everything else on the shell is refused, so a night run never waits for a yes.
# timeout and chunkTimeout (ms): OpenCode otherwise gives up quickly while waiting for an answer, and on basement's CPU
# Qwen can read a long prompt for longer than that (the first night's task 1 timed out and retried).
$cfg = Join-Path $repo 'opencode.json'
@'
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": { "baseURL": "http://127.0.0.1:11434/v1", "timeout": 2700000, "chunkTimeout": 2700000 },
      "models": { "qwen3.5:4b": { "name": "Qwen 3.5 4B" } }
    }
  },
  "model": "ollama/qwen3.5:4b",
  "permission": {
    "edit": "allow",
    "webfetch": "deny",
    "bash": { "*": "deny", "git status*": "allow", "git diff*": "allow", "git log*": "allow" }
  }
}
'@ | Set-Content -Encoding UTF8 $cfg
$excl = Join-Path $repo '.git\info\exclude'
foreach ($p in @('opencode.json', 'vm-intent/AGENTS.md')) { if (-not (Select-String -Quiet -SimpleMatch $p $excl -ErrorAction SilentlyContinue)) { Add-Content $excl $p } }

Say "Starting $($tasks.Count) tasks in $repo on branch qwen/tests"
foreach ($t in $tasks) {
  try { Invoke-RestMethod http://127.0.0.1:11434/api/version -TimeoutSec 10 | Out-Null } catch { Say "Ollama is not answering; stopping."; break }
  $log = Join-Path $out "$($t.id).log"
  Say "Task $($t.id): started"
  $started = Get-Date
  $job = Start-Job -ScriptBlock { param($r, $p, $path) $env:Path = $path; Set-Location $r; opencode run --model ollama/qwen3.5:4b $p 2>&1 } -ArgumentList $repo, $t.prompt, $env:Path
  if (-not (Wait-Job $job -Timeout $limit)) { Stop-Job $job; Say "Task $($t.id): stopped after $($limit/60) minutes" }
  Receive-Job $job | Out-File -Encoding UTF8 $log
  Remove-Job $job -Force
  $mins = [math]::Round(((Get-Date) - $started).TotalMinutes, 1)

  # Keep only the files this task is meant to create; undo anything else it changed.
  foreach ($k in $t.keep) { git add -- $k 2>$null }
  git stash push -q --keep-index --include-untracked -m "qwen-$($t.id)-other" 2>$null
  git stash drop -q 2>$null
  $staged = git diff --cached --name-only
  if ($staged) {
    git commit -q -m "qwen task $($t.id) (Qwen 3.5 4B via OpenCode, not yet compiled or reviewed)"
    git format-patch -1 HEAD --stdout | Out-File -Encoding UTF8 (Join-Path $out "$($t.id).patch")
    Say "Task $($t.id): committed $($staged -join ', ') after $mins min"
  } else {
    Say "Task $($t.id): produced nothing to keep after $mins min (see $($t.id).log)"
  }
}
Say "All tasks done. Branch qwen/tests: $(git log --oneline main..HEAD 2>$null | Measure-Object -Line | Select-Object -ExpandProperty Lines) new commits."
