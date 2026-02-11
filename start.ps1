# Quokka - Start server and open Edge in app mode
$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir "quokka.pid"
$configFile = Join-Path $scriptDir "config.json"

# Read port from config
$port = 8080
if (Test-Path $configFile) {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($config.port) { $port = $config.port }
}

$url = "http://127.0.0.1:$port"

# Check if server is already running
$alreadyRunning = $false
if (Test-Path $pidFile) {
    $serverPid = (Get-Content $pidFile -Raw).Trim()
    try {
        $proc = Get-Process -Id $serverPid -ErrorAction Stop
        if ($proc.ProcessName -match "python") {
            $alreadyRunning = $true
            Write-Host "Quokka server already running (PID $serverPid)"
        }
    } catch {
        Remove-Item $pidFile -Force
    }
}

# Start server if not running
if (-not $alreadyRunning) {
    $serverScript = Join-Path $scriptDir "server.py"
    $proc = Start-Process -FilePath "python" -ArgumentList $serverScript `
        -WorkingDirectory $scriptDir -WindowStyle Hidden -PassThru
    $proc.Id | Out-File $pidFile -NoNewline
    Write-Host "Started Quokka server (PID $($proc.Id))"
    Start-Sleep -Seconds 1
}

# Open Edge in app mode
$edgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edgePath) {
    Start-Process -FilePath $edgePath -ArgumentList "--app=$url"
} else {
    Write-Host "Edge not found, opening in default browser"
    Start-Process $url
}
