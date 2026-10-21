# Prints the addresses for opening vm-intent from other devices on your network,
# and saves them to addresses.txt next to this script.
$ips = Get-NetIPConfiguration |
    Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
    ForEach-Object { $_.IPv4Address.IPAddress }
if (-not $ips) { $ips = @('(no network connection found)') }
$lines = @("vm-intent addresses for other devices on your network (this PC: $env:COMPUTERNAME)", "")
foreach ($ip in $ips) {
    $lines += "  Web app       http://${ip}:5173"
    $lines += "  Swagger UI    http://${ip}:8080/swagger-ui.html"
    $lines += "  Temporal UI   http://${ip}:8233"
    $lines += ""
}
$lines += "On this PC itself, http://localhost works too."
$lines += "If another device can't connect, allow Node.js, Java and temporal.exe through Windows Firewall (private networks)."
$lines | Tee-Object -FilePath (Join-Path $PSScriptRoot 'addresses.txt')
