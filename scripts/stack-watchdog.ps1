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
    3. If the bot container is running but BLIND — no completed poll in
       $StaleMinutes minutes, judged from bot/data/ptb_health.jsonl by
       bot/scripts/botLiveness.mts — restart the container; if that did not
       cure it within the last 30 minutes, restart Docker Desktop instead.
       Measured 2026-09-06: 11.8 hours of "Up" with every poll timing out,
       invisible to checks 1 and 2.

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
$LivenessScript = Join-Path $RepoRoot 'bot\scripts\botLiveness.mts'
$StateFile = Join-Path $RepoRoot 'bot\data\watchdog_state.json'
# No completed poll for this long while the container runs = alive but blind.
$StaleMinutes = 10
# A container younger than this has not had time to write its first rollup.
$GraceMinutes = 5
# A second blind verdict this soon after a container restart escalates to Docker.
$EscalateWithinMinutes = 30

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

function Get-BotUptimeMinutes {
    try {
        $started = & docker inspect --format '{{.State.StartedAt}}' polymarket-bot 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $started) { return $null }
        # Docker prints nanoseconds; .NET parses at most 7 fractional digits.
        $clean = [regex]::Replace([string]$started, '\.\d+Z$', 'Z')
        $startedAt = [DateTime]::Parse($clean, $null, [Globalization.DateTimeStyles]::AdjustToUniversal)
        return ((Get-Date).ToUniversalTime() - $startedAt).TotalMinutes
    } catch { return $null }
}

function Get-BotLiveness {
    # Code: 0 fresh, 2 stale, 3 no data. Anything else means the check itself
    # failed — treated as fresh, so a broken check can never cause a restart.
    try {
        $out = & node $LivenessScript --stale-min $StaleMinutes 2>$null
        $detail = if ($out) { [string]($out | Select-Object -Last 1) } else { '' }
        return @{ Code = $LASTEXITCODE; Detail = $detail }
    } catch { return @{ Code = -1; Detail = $_.Exception.Message } }
}

function Read-WatchdogState {
    try {
        if (Test-Path $StateFile) { return Get-Content $StateFile -Raw | ConvertFrom-Json }
    } catch { }
    return $null
}

function Get-StateValue($State, [string]$Name) {
    # StrictMode throws on a missing property; the state file may predate a key.
    if ($null -eq $State) { return $null }
    $prop = $State.PSObject.Properties[$Name]
    if ($null -eq $prop) { return $null }
    return $prop.Value
}

function Write-WatchdogState([hashtable]$State) {
    try { $State | ConvertTo-Json -Compress | Set-Content -Path $StateFile } catch { }
}

function Restart-BotContainer {
    Push-Location $RepoRoot
    try {
        & docker compose restart bot 2>&1 | Out-Null
        return $LASTEXITCODE -eq 0
    } finally { Pop-Location }
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
    $live = if ($botUp) { Get-BotLiveness } else { @{ Code = -1; Detail = 'n/a' } }
    Write-Log "CHECK ONLY - engine up: $engineUp | bot running: $botUp | liveness: $($live.Code) $($live.Detail)"
    exit 0
}

if (-not $engineUp) {
    if (-not (Restart-DockerDesktop)) { exit 1 }
}

if (Test-BotRunning) {
    $uptime = Get-BotUptimeMinutes
    if ($uptime -ne $null -and $uptime -lt $GraceMinutes) { exit 0 }

    $live = Get-BotLiveness
    if ($live.Code -ne 2 -and $live.Code -ne 3) {
        # Fresh, or the check itself could not run: stay silent so the log
        # records interventions, not heartbeats.
        exit 0
    }

    # Alive but blind. First try the cheap fix; escalate if it already failed once.
    $state = Read-WatchdogState
    $lastBotRestart = [DateTime]::MinValue
    $lastBotRestartRaw = Get-StateValue $state 'lastBotRestart'
    if ($lastBotRestartRaw) {
        try { $lastBotRestart = [DateTime]::Parse([string]$lastBotRestartRaw) } catch { }
    }
    $now = Get-Date
    if (($now - $lastBotRestart).TotalMinutes -lt $EscalateWithinMinutes) {
        Write-Log "Bot still blind after container restart at $($lastBotRestart.ToString('s')) - $($live.Detail) - restarting Docker Desktop"
        if (-not (Restart-DockerDesktop)) { exit 1 }
        Write-WatchdogState @{ lastBotRestart = $now.ToString('o'); lastDockerRestart = $now.ToString('o') }
        if (Start-Stack) { exit 0 } else { exit 1 }
    }

    Write-Log "Bot running but blind - $($live.Detail) - restarting the bot container"
    Write-WatchdogState @{ lastBotRestart = $now.ToString('o'); lastDockerRestart = (Get-StateValue $state 'lastDockerRestart') }
    if (Restart-BotContainer) { Write-Log 'Bot container restarted'; exit 0 }
    Write-Log 'docker compose restart bot failed'
    exit 1
}

if (Start-Stack) { exit 0 } else { exit 1 }
