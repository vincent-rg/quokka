# Quokka - Remove the logon scheduled task (and stop the server unless -KeepRunning)
param(
    [string]$TaskName = "Quokka Server",
    [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($task) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "Removed scheduled task '$TaskName'"
} else {
    Write-Host "Scheduled task '$TaskName' not found, nothing to remove"
}

if (-not $KeepRunning) {
    & (Join-Path $scriptDir "stop.ps1")
}
