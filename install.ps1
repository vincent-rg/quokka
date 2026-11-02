# Quokka - Register a scheduled task that starts the server at logon (current user, no admin needed)
param(
    [string]$TaskName = "Quokka Server",
    [switch]$NoStartNow
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startScript = Join-Path $scriptDir "start.ps1"

if (-not (Test-Path $startScript)) {
    Write-Host "start.ps1 not found in $scriptDir"
    exit 1
}

$user = "$env:USERDOMAIN\$env:USERNAME"

$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$startScript`" -NoBrowser" `
    -WorkingDirectory $scriptDir

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

# No execution time limit, keep running on battery
$settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName `
    -Action $action -Trigger $trigger -Principal $principal -Settings $settings `
    -Description "Starts the Quokka work time tracker server at logon" `
    -Force | Out-Null

Write-Host "Registered scheduled task '$TaskName' (runs at logon for $user)"

if (-not $NoStartNow) {
    Start-ScheduledTask -TaskName $TaskName
    Write-Host "Started task now - server should be up in a few seconds"
}
