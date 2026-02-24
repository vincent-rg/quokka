# Quokka - Start server and open in Edge (installed app or app mode)
param(
    [string]$AppId = "",
    [string]$LaunchSource = "app_launcher",
    [string]$ProfileDirectory = "Default"
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$pidFile = Join-Path $scriptDir "quokka.pid"
$configFile = Join-Path $scriptDir "config.json"

# Read port from config
$port = 8080
if (Test-Path $configFile) {
    $config = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($config.port) { $port = $config.port }
    if (-not $AppId -and $config.edge_app_id) { $AppId = $config.edge_app_id }
    if ($config.edge_profile_directory) { $ProfileDirectory = $config.edge_profile_directory }
    if ($config.edge_launch_source) { $LaunchSource = $config.edge_launch_source }
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

# Try to launch as installed Edge PWA via msedge_proxy.exe
if ($AppId) {
    $edgeAppDir = "${env:ProgramFiles(x86)}\Microsoft\Edge\Application"
    if (-not (Test-Path $edgeAppDir)) {
        $edgeAppDir = "$env:ProgramFiles\Microsoft\Edge\Application"
    }
    $proxyPath = Get-ChildItem -Path $edgeAppDir -Filter "msedge_proxy.exe" -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty FullName

    if ($proxyPath) {
        Write-Host "Launching as installed Edge app (ID: $AppId)"
        Start-Process -FilePath $proxyPath -ArgumentList @(
            "--profile-directory=$ProfileDirectory",
            "--app-id=$AppId",
            "--app-launch-url=$url",
            "--launch-source=$LaunchSource"
        )
        exit
    } else {
        Write-Host "msedge_proxy.exe not found, falling back to Edge app mode"
    }
}

# Fallback: open Edge in app mode
$edgePaths = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgePath = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1

if ($edgePath) {
    Write-Host "Opening in Edge app mode"
    Start-Process -FilePath $edgePath -ArgumentList "--app=$url"
} else {
    Write-Host "Edge not found, opening in default browser"
    Start-Process $url
}
