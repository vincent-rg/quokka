# Quokka - Stop server
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir "quokka.pid"
$configFile = Join-Path $scriptDir "config.json"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found. Server may not be running."
    exit 0
}

# Read port from config
$port = 8080
if (Test-Path $configFile) {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($config.port) { $port = $config.port }
}

$serverPid = (Get-Content $pidFile -Raw).Trim()
try {
    $proc = Get-Process -Id $serverPid -ErrorAction Stop
    if ($proc.ProcessName -notmatch "python") {
        Write-Host "PID $serverPid is not a Python process, ignoring."
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        exit 0
    }
    # Verify it's actually the Quokka server
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ($resp.Content -notmatch "Quokka") {
            Write-Host "PID $serverPid is Python but not responding as Quokka, ignoring."
            Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
            exit 0
        }
    } catch {
        Write-Host "PID $serverPid is Python but not responding on port $port, ignoring."
        Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
        exit 0
    }
    Stop-Process -Id $serverPid -Force
    Write-Host "Stopped Quokka server (PID $serverPid)"
} catch {
    Write-Host "Process $serverPid not found. Server may have already stopped."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
