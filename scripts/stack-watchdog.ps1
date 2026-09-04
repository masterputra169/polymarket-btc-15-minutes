<#
.SYNOPSIS
  Keeps the Polymarket bot stack running, and logs every intervention.

.DESCRIPTION
  On 2026-09-02 and again on 2026-09-04 the Docker engine hung on this machine
  with a stale backend process, and the bot stopped without anyone noticing —
  an observation period that looked like it was running had in fact collected
  nothing. Sleep and hibernate were already disabled and the machine had not
  rebooted, so the cause was Docker itself, not power management.

  This script is the recovery path for exactly that failure:
    1. If the Docker engine does not answer, force-restart Docker Desktop
       (kill stale processes, shut down the WSL VM, cold start) and wait.
    2. If the bot container is not running, bring the stack up.

  It deliberately runs `docker compose up -d` with NO override file, so the
  bot's mode comes from DRY_RUN in bot/.env and the watchdog can never flip a
  live bot into dry-run — or a dry-run bot into live — behind your back.

.NOTES
  Install as a scheduled task (every 10 minutes) with:
      scripts\install-watchdog.ps1
  Log: bot/data/watchdog.log
#>

[CmdletBinding()]
param(
    # How long to wait for the Docker engine after a restart, in seconds.
    [int]$EngineTimeoutSec = 300,
    # Check only; make no changes. Useful for verifying the install.
    [switch]$WhatIfOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$LogFile = Join-Path $RepoRoot 'bot\data\watchdog.log'
$DockerExe = 'A:\Docker\Docker\frontend\Docker Desktop.exe'

function Write-Log {
    param([string]$Message)
    $line = "{0} [Watchdog] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    Write-Output $line
    try { Add-Content -Path $LogFile -Value $line -ErrorAction Stop } catch { }
}

function Test-DockerEngine {
    try {
        $null = & docker info --format '{{.ServerVersion}}' 2>$null
        return $LASTEXITCODE -eq 0
    } catch { return $false }
}

function Test-BotRunning {
    try {
        $names = & docker ps --filter 'name=polymarket-bot' --format '{{.Names}}' 2>$null
        return $LASTEXITCODE -eq 0 -and $names -contains 'polymarket-bot'
    } catch { return $false }
}

function Restart-DockerDesktop {
    Write-Log 'Docker engine unreachable - force restarting Docker Desktop'
    foreach ($proc in 'Docker Desktop', 'com.docker.backend', 'com.docker.build') {
        Get-Process $proc -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Seconds 3
    # The engine hang leaves the WSL VM in a bad state; a plain relaunch is not enough.
    & wsl --shutdown 2>$null | Out-Null
    Start-Sleep -Seconds 6
    if (-not (Test-Path $DockerExe)) {
        Write-Log "Docker Desktop not found at $DockerExe - cannot restart"
        return $false
    }
    Start-Process $DockerExe | Out-Null

    $deadline = (Get-Date).AddSeconds($EngineTimeoutSec)
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Seconds 15
        if (Test-DockerEngine) {
            Write-Log 'Docker engine is up again'
            return $true
        }
    }
    Write-Log "Docker engine still down after ${EngineTimeoutSec}s - giving up this cycle"
    return $false
}

function Start-Stack {
    Write-Log 'Bot container not running - bringing the stack up'
    Push-Location $RepoRoot
    try {
        # No -f override: DRY_RUN comes from bot/.env, so the watchdog never
        # changes which mode the bot runs in.
        & docker compose up -d 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0) {
            Write-Log 'Stack started'
            return $true
        }
        Write-Log "docker compose up failed with exit code $LASTEXITCODE"
        return $false
    } finally {
        Pop-Location
    }
}

# --- main ---------------------------------------------------------------
$engineUp = Test-DockerEngine

if ($WhatIfOnly) {
    $botUp = if ($engineUp) { Test-BotRunning } else { $false }
    Write-Log "CHECK ONLY - engine up: $engineUp | bot running: $botUp"
    exit 0
}

if (-not $engineUp) {
    if (-not (Restart-DockerDesktop)) { exit 1 }
}

if (Test-BotRunning) {
    # Healthy: stay silent so the log records interventions, not heartbeats.
    exit 0
}

if (Start-Stack) { exit 0 } else { exit 1 }
