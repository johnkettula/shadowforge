# setup-mcp.ps1
# 1. Builds the vm-intent MCP server (mcp-server folder).
# 2. Registers it in the Claude desktop app, and, if you give a GitLab address,
#    registers GitLab's own MCP server too.
# Your existing Claude config is backed up first. Restart the Claude app afterwards.
#
# Run: double-click 4-setup-mcp.cmd, or
#   powershell -ExecutionPolicy Bypass -File .\setup-mcp.ps1 [-GitLabUrl https://gitlab.example.com]
# The GitLab address can also be put in gitlab-host.txt (one line) next to this script.

param([string]$GitLabUrl = "")

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$McpDir = Join-Path $Root "mcp-server"

function Write-Step($t) { Write-Host ""; Write-Host "==> $t" -ForegroundColor Cyan }
function Write-Ok($t) { Write-Host "    $t" -ForegroundColor Green }

# Make tools installed by install-prereqs.ps1 visible in this window.
$env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")

$node = (Get-Command node -ErrorAction SilentlyContinue)
if (-not $node) { throw "Node.js was not found. Run 0-install-prereqs.cmd first." }
$nodeExe = $node.Source
$npxCmd = Join-Path (Split-Path $nodeExe) "npx.cmd"

# ---------------------------------------------------------------- build
Write-Step "Building the vm-intent MCP server"
Push-Location $McpDir
try {
    & (Join-Path (Split-Path $nodeExe) "npm.cmd") install --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
    & (Join-Path (Split-Path $nodeExe) "npm.cmd") run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} finally { Pop-Location }
$serverJs = Join-Path $McpDir "dist\index.js"
if (-not (Test-Path $serverJs)) { throw "Build did not produce $serverJs" }
Write-Ok "Built $serverJs"

# ---------------------------------------------------------------- GitLab address
if (-not $GitLabUrl) {
    $hostFile = Join-Path $Root "gitlab-host.txt"
    if (Test-Path $hostFile) { $GitLabUrl = (Get-Content $hostFile -TotalCount 1).Trim() }
}
$GitLabUrl = $GitLabUrl.TrimEnd("/")

# ---------------------------------------------------------------- Claude config
Write-Step "Registering MCP servers with the Claude desktop app"

# The normal installer reads %APPDATA%\Claude. The Microsoft Store build is
# sandboxed and reads %LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude.
# Write the config to every location that applies.
$cfgDirs = @(Join-Path $env:APPDATA "Claude")
Get-ChildItem (Join-Path $env:LOCALAPPDATA "Packages") -Directory -Filter "Claude_*" -ErrorAction SilentlyContinue |
    ForEach-Object { $cfgDirs += (Join-Path $_.FullName "LocalCache\Roaming\Claude") }

foreach ($cfgDir in $cfgDirs) {
$cfgFile = Join-Path $cfgDir "claude_desktop_config.json"
New-Item -ItemType Directory -Force -Path $cfgDir | Out-Null

$cfg = [pscustomobject]@{}
if (Test-Path $cfgFile) {
    $backup = "$cfgFile.bak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
    Copy-Item $cfgFile $backup
    Write-Ok "Backed up the current config to $backup"
    $raw = Get-Content $cfgFile -Raw
    if ($raw.Trim()) { $cfg = $raw | ConvertFrom-Json }
}
if (-not $cfg.PSObject.Properties["mcpServers"]) {
    $cfg | Add-Member -NotePropertyName mcpServers -NotePropertyValue ([pscustomobject]@{}) -Force
}

function Set-Server($name, $value) {
    if ($cfg.mcpServers.PSObject.Properties[$name]) { $cfg.mcpServers.PSObject.Properties.Remove($name) }
    $cfg.mcpServers | Add-Member -NotePropertyName $name -NotePropertyValue $value
}

Set-Server "vm-intent" ([pscustomobject]@{
    command = $nodeExe
    args    = @($serverJs)
    env     = [pscustomobject]@{ VMINTENT_API_BASE = "http://localhost:8080"; VMINTENT_HOME = $Root }
})
Write-Ok "vm-intent -> $serverJs"

if ($GitLabUrl) {
    Set-Server "GitLab" ([pscustomobject]@{
        command = $npxCmd
        args    = @("-y", "mcp-remote", "$GitLabUrl/api/v4/mcp")
    })
    Write-Ok "GitLab    -> $GitLabUrl/api/v4/mcp (GitLab's built-in MCP server)"
} else {
    Write-Host "    No GitLab address given, so GitLab was not added. Put it in gitlab-host.txt and run this again." -ForegroundColor Yellow
}

# Write UTF-8 without a byte-order mark (the Claude app can't read one).
$json = $cfg | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($cfgFile, $json, (New-Object System.Text.UTF8Encoding $false))
Write-Ok "Saved $cfgFile"
}

Write-Host ""
Write-Host "Done. Quit the Claude desktop app completely (system tray > Quit) and open it again." -ForegroundColor Green
if ($GitLabUrl) {
    Write-Host "The first time GitLab connects, a browser window asks you to approve access. Your GitLab admin" -ForegroundColor Green
    Write-Host "must have allowed the MCP server (GitLab 19.5 or newer, or 18.6+ as beta)." -ForegroundColor Green
}
