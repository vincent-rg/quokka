# Quokka - Stop server
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir "quokka.pid"

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file found. Server may not be running."
    exit 0
}

$pid = (Get-Content $pidFile -Raw).Trim()
try {
    $proc = Get-Process -Id $pid -ErrorAction Stop
    if ($proc.ProcessName -match "python") {
        Stop-Process -Id $pid -Force
        Write-Host "Stopped Quokka server (PID $pid)"
    } else {
        Write-Host "PID $pid is not a Python process, ignoring."
    }
} catch {
    Write-Host "Process $pid not found. Server may have already stopped."
}

Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
