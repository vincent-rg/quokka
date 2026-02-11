# Quokka - Stop server
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir "quokka.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found. Server may not be running."
    exit 0
}

$serverPid = (Get-Content $pidFile -Raw).Trim()
try {
    $proc = Get-Process -Id $serverPid -ErrorAction Stop
    if ($proc.ProcessName -match "python") {
        Stop-Process -Id $serverPid -Force
        Write-Host "Stopped Quokka server (PID $serverPid)"
    } else {
        Write-Host "PID $serverPid is not a Python process, ignoring."
    }
} catch {
    Write-Host "Process $serverPid not found. Server may have already stopped."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
