<#
.SYNOPSIS
  Registers the stack watchdog as a Windows scheduled task, and makes Docker
  Desktop start with the machine.

.DESCRIPTION
  Run once, from an elevated PowerShell if you want the task to survive across
  users; a normal shell is enough for the current user.

      powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1

  Creates:
    - Scheduled task "PolyBTC15 Stack Watchdog", every 10 minutes, running
      scripts\stack-watchdog.ps1 hidden.
    - A Startup-folder shortcut for Docker Desktop, so a reboot brings the
      engine back without anyone logging in and clicking it.

  Remove both with:
      powershell -ExecutionPolicy Bypass -File scripts\install-watchdog.ps1 -Uninstall
#>

[CmdletBinding()]
param(
    [switch]$Uninstall,
    [int]$IntervalMinutes = 10
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$TaskName = 'PolyBTC15 Stack Watchdog'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Script = Join-Path $PSScriptRoot 'stack-watchdog.ps1'
$StartupDir = [Environment]::GetFolderPath('Startup')
$Shortcut = Join-Path $StartupDir 'Docker Desktop.lnk'
$DockerExe = 'A:\Docker\Docker\frontend\Docker Desktop.exe'

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Removed scheduled task: $TaskName"
    } else {
        Write-Output "Scheduled task not present: $TaskName"
    }
    if (Test-Path $Shortcut) {
        Remove-Item $Shortcut -Force
        Write-Output "Removed startup shortcut: $Shortcut"
    }
    exit 0
}

if (-not (Test-Path $Script)) { throw "Watchdog script not found: $Script" }

# --- scheduled task ------------------------------------------------------
$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Script`"" `
    -WorkingDirectory $RepoRoot

$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)

# Run whether or not the user is logged on is deliberately NOT set: Docker
# Desktop needs an interactive session, so the task follows the logged-on user.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) -MultipleInstances IgnoreNew

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Description 'Restarts the Docker engine and the Polymarket stack if either stops.' | Out-Null
Write-Output "Registered scheduled task: $TaskName (every $IntervalMinutes min)"

# --- Docker Desktop autostart -------------------------------------------
if (Test-Path $DockerExe) {
    $ws = New-Object -ComObject WScript.Shell
    $lnk = $ws.CreateShortcut($Shortcut)
    $lnk.TargetPath = $DockerExe
    $lnk.WorkingDirectory = Split-Path -Parent $DockerExe
    $lnk.Description = 'Start Docker Desktop at login (PolyBTC15 stack)'
    $lnk.Save()
    Write-Output "Created startup shortcut: $Shortcut"
} else {
    Write-Warning "Docker Desktop not found at $DockerExe - skipped autostart shortcut"
}

Write-Output ''
Write-Output 'Verify with:  powershell -ExecutionPolicy Bypass -File scripts\stack-watchdog.ps1 -WhatIfOnly'
Write-Output 'Log:          bot\data\watchdog.log'
