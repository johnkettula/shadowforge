# install-prereqs.ps1
# Installs what the vm-intent project needs on Windows:
#   Java 21, Node.js LTS, Maven and the Temporal CLI.
# Anything already installed is skipped, so it is safe to run again.
#
# Run it by double-clicking 0-install-prereqs.cmd, or from PowerShell:
#   powershell -ExecutionPolicy Bypass -File .\install-prereqs.ps1
#
# Windows will ask "Do you want to allow this app to make changes?" for
# Java. Click Yes. Node.js installs without a prompt.

$ErrorActionPreference = "Stop"
$ToolsDir = Join-Path $env:USERPROFILE "tools"
$MavenVersion = "3.9.11"
$NodeVersion = "24.20.0"

function Write-Step($text) { Write-Host ""; Write-Host "==> $text" -ForegroundColor Cyan }
function Write-Ok($text)   { Write-Host "    $text" -ForegroundColor Green }
function Write-Warn2($text){ Write-Host "    $text" -ForegroundColor Yellow }

# Re-read PATH so tools installed a moment ago are found in this window.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
    $user = [Environment]::GetEnvironmentVariable("Path", "User")
    $env:Path = "$machine;$user"
}

# Adds a folder to the user's PATH permanently (no admin needed).
function Add-ToUserPath($folder) {
    $current = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($null -eq $current) { $current = "" }
    $parts = $current.Split(";") | Where-Object { $_ -ne "" }
    if ($parts -notcontains $folder) {
        $new = (($parts + $folder) -join ";")
        [Environment]::SetEnvironmentVariable("Path", $new, "User")
        Write-Ok "Added to PATH: $folder"
    }
    Update-SessionPath
}

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

# Runs a command through cmd so version text printed to stderr is captured safely.
function Get-VersionText($command) {
    return (cmd /c "$command 2>&1" | Out-String).Trim()
}

function Assert-Winget {
    if (-not (Test-Command "winget")) {
        throw "winget was not found. Install 'App Installer' from the Microsoft Store, then run this script again."
    }
}

# ---------------------------------------------------------------- Java 21
Write-Step "Java 21"
# The project is built for Java 21, so install JDK 21 specifically (it can sit
# next to other Java versions). JAVA_HOME below points Maven at it.
$jdk21 = Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue
if ($jdk21) {
    Write-Ok "Already installed ($($jdk21[0].Name))."
} else {
    Assert-Winget
    Write-Host "    Installing Microsoft Build of OpenJDK 21..."
    winget install --id Microsoft.OpenJDK.21 -e --accept-source-agreements --accept-package-agreements
    Update-SessionPath
}

# JAVA_HOME helps Maven and IDEs find Java.
$jdk = Get-ChildItem "C:\Program Files\Microsoft" -Directory -Filter "jdk-21*" -ErrorAction SilentlyContinue |
       Sort-Object Name -Descending | Select-Object -First 1
if ($jdk) {
    [Environment]::SetEnvironmentVariable("JAVA_HOME", $jdk.FullName, "User")
    $env:JAVA_HOME = $jdk.FullName
    Add-ToUserPath (Join-Path $jdk.FullName "bin")
    Write-Ok "JAVA_HOME = $($jdk.FullName)"
} elseif (-not $env:JAVA_HOME) {
    Write-Warn2 "Could not find the JDK folder to set JAVA_HOME. Maven will still use 'java' from PATH."
}

# ---------------------------------------------------------------- Node.js
Write-Step "Node.js (LTS)"
$nodeMajor = 0
if (Test-Command "node") {
    $v = Get-VersionText "node -v"
    if ($v -match 'v(\d+)') { $nodeMajor = [int]$Matches[1] }
}
if ($nodeMajor -ge 20) {
    Write-Ok "Already installed (Node $nodeMajor)."
} else {
    # The portable zip needs no admin rights, so there is no Windows prompt.
    $nodeName = "node-v$NodeVersion-win-x64"
    $nodeDir = Join-Path $ToolsDir $nodeName
    if (-not (Test-Path (Join-Path $nodeDir "node.exe"))) {
        $zip = Join-Path $env:TEMP "$nodeName.zip"
        Write-Host "    Downloading Node.js $NodeVersion (portable, no admin needed)..."
        Invoke-WebRequest -Uri "https://nodejs.org/dist/v$NodeVersion/$nodeName.zip" -OutFile $zip -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
        Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
        Remove-Item $zip
    }
    Add-ToUserPath $nodeDir
}

# ---------------------------------------------------------------- Maven
Write-Step "Maven"
if (Test-Command "mvn") {
    Write-Ok "Already installed."
} else {
    $mavenHome = $null

    # Reuse a Maven that was already downloaded and unzipped in Downloads.
    $downloaded = Get-ChildItem (Join-Path $env:USERPROFILE "Downloads") -Directory -Recurse -Depth 1 `
                    -Filter "apache-maven-*" -ErrorAction SilentlyContinue |
                  Where-Object { Test-Path (Join-Path $_.FullName "bin\mvn.cmd") } |
                  Select-Object -First 1
    if ($downloaded) {
        $mavenHome = Join-Path $ToolsDir $downloaded.Name
        if (-not (Test-Path $mavenHome)) {
            New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
            Copy-Item $downloaded.FullName $mavenHome -Recurse
        }
        Write-Ok "Using Maven from Downloads: $($downloaded.Name)"
    } else {
        $zip = Join-Path $env:TEMP "apache-maven-$MavenVersion-bin.zip"
        $url = "https://archive.apache.org/dist/maven/maven-3/$MavenVersion/binaries/apache-maven-$MavenVersion-bin.zip"
        Write-Host "    Downloading Maven $MavenVersion..."
        Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
        New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
        Expand-Archive -Path $zip -DestinationPath $ToolsDir -Force
        Remove-Item $zip
        $mavenHome = Join-Path $ToolsDir "apache-maven-$MavenVersion"
    }
    [Environment]::SetEnvironmentVariable("MAVEN_HOME", $mavenHome, "User")
    Add-ToUserPath (Join-Path $mavenHome "bin")
}

# ---------------------------------------------------------------- Temporal CLI
Write-Step "Temporal CLI"
if (Test-Command "temporal") {
    Write-Ok "Already installed."
} else {
    $temporalDir = Join-Path $ToolsDir "temporal"
    $zip = Join-Path $env:TEMP "temporal-cli.zip"
    Write-Host "    Downloading the Temporal CLI..."
    Invoke-WebRequest -Uri "https://temporal.download/cli/archive/latest?platform=windows&arch=amd64" `
                      -OutFile $zip -UseBasicParsing
    New-Item -ItemType Directory -Force -Path $temporalDir | Out-Null
    Expand-Archive -Path $zip -DestinationPath $temporalDir -Force
    Remove-Item $zip
    # The exe may sit in a subfolder of the zip; find it.
    $exe = Get-ChildItem $temporalDir -Recurse -Filter "temporal.exe" | Select-Object -First 1
    if (-not $exe) { throw "temporal.exe was not found in the downloaded archive." }
    Add-ToUserPath $exe.DirectoryName
}

# ---------------------------------------------------------------- Summary
Write-Step "Check"
$checks = @(
    @{ Name = "Java";     Cmd = "java -version" },
    @{ Name = "Maven";    Cmd = "mvn -v" },
    @{ Name = "Node.js";  Cmd = "node -v" },
    @{ Name = "Temporal"; Cmd = "temporal --version" }
)
$allGood = $true
foreach ($c in $checks) {
    $exeName = $c.Cmd.Split(" ")[0]
    if (Test-Command $exeName) {
        $first = (Get-VersionText $c.Cmd).Split("`n")[0].Trim()
        Write-Ok ("{0,-9} {1}" -f $c.Name, $first)
    } else {
        Write-Warn2 ("{0,-9} NOT FOUND" -f $c.Name)
        $allGood = $false
    }
}

if ($env:JAVA_HOME -and (Test-Path (Join-Path $env:JAVA_HOME "bin\java.exe"))) {
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    $jh = (& (Join-Path $env:JAVA_HOME "bin\java.exe") -version 2>&1 | ForEach-Object { "$_" } | Select-Object -First 1)
    $ErrorActionPreference = $prev
    Write-Ok ("{0,-9} {1}  (used by Maven)" -f "JAVA_HOME", $jh)
}

Write-Host ""
if ($allGood) {
    Write-Host "All set. Close this window, open a NEW one, then run 1-start-temporal.cmd." -ForegroundColor Green
} else {
    Write-Host "Something is missing (see above). Open a NEW PowerShell window and run this script again." -ForegroundColor Yellow
}
