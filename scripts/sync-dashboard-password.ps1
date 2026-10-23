param(
  [string]$VpsHost = "43.129.33.237",
  [string]$VpsUser = "ubuntu",
  [string]$KeyPath = "$HOME\.ssh\id_ed25519",
  [string]$LocalFile = "$HOME\.poly15\dashboard-password.txt"
)
$ErrorActionPreference = "Stop"
$remote = "$VpsUser@$VpsHost"
$pw = & ssh -i $KeyPath -o BatchMode=yes -o StrictHostKeyChecking=accept-new $remote "sudo cat /root/.poly15-dashboard-password-latest" 2>$null
if ($LASTEXITCODE -ne 0 -or -not $pw) { Write-Error "Could not read the dashboard password fallback from the VPS"; exit 1 }
$value = ($pw | Out-String).Trim()
if ($value.Length -lt 8 -or $value.Length -gt 200) { Write-Error "Unexpected password length"; exit 1 }
$dir = Split-Path -Parent $LocalFile
New-Item -ItemType Directory -Force -Path $dir | Out-Null
$nl = [Environment]::NewLine
$content = "POLY//15 dashboard password" + $nl + $value + $nl + $nl + "Rotated daily at 07:00 WIB. Synced by the Poly15 scheduled task." + $nl
Set-Content -LiteralPath $LocalFile -Value $content -Encoding UTF8 -NoNewline
icacls $LocalFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" | Out-Null
Write-Output "dashboard password synced"
