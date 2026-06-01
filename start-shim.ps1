# deepseek-think-fix — smart auto-detect launcher with watchdog.
#
# IMPORTANT — manual start only:
#   This script runs ONLY when the user explicitly invokes it (double-click
#   start-shim.cmd / start-shim-hidden.cmd, or runs this .ps1 directly).
#   Nothing in this project registers itself with the OS auto-start list,
#   the task scheduler, or any "run at login" mechanism.
#
# Lifecycle:
#   - start-shim.cmd  → user starts shim + watchdog
#   - watchdog        → restarts node ONLY on a crash (not on stop-shim)
#   - stop-shim.cmd   → user stops EVERYTHING; never auto-restarts
#
# To stop cleanly: double-click stop-shim.cmd. That removes the PID file
# (which signals the watchdog to exit) and kills the whole process tree.

[CmdletBinding()]
param(
  [int]$Port = 8788,
  [switch]$NoEdit         # only start shim, don't touch settings.json
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
$shimUrl  = "http://127.0.0.1:$Port"
$backupDir = Join-Path $here 'backups'
$pidFile   = Join-Path $here '.shim-pid.txt'
$watchdogFile = Join-Path $here '.watchdog.cmd'

if (-not (Test-Path $backupDir)) { New-Item -ItemType Directory -Path $backupDir | Out-Null }

# --- 1. Read current CC settings ---
if (-not (Test-Path $settings)) { throw "settings.json not found: $settings" }
$cfg = Get-Content $settings -Raw | ConvertFrom-Json
$currentBase = $cfg.env.ANTHROPIC_BASE_URL

Write-Host "Current ANTHROPIC_BASE_URL: $currentBase"

# --- 2. Decide upstream ---
$lastUpstreamFile = Join-Path $backupDir 'last-upstream.txt'

if ($currentBase -eq $shimUrl) {
  if (-not (Test-Path $lastUpstreamFile)) {
    throw "BASE_URL already points at shim ($shimUrl) but no backups\last-upstream.txt found. Run stop-shim.cmd first."
  }
  $upstream = (Get-Content $lastUpstreamFile -Raw).Trim()
  Write-Host "Re-using saved upstream: $upstream"
} else {
  $upstream = $currentBase
  $upstream | Set-Content -Path $lastUpstreamFile -Encoding ASCII
  Write-Host "Detected upstream: $upstream"
}

if (-not ($upstream -match '^https?://')) {
  throw "Invalid upstream URL: $upstream"
}

# --- 3. Stop any existing shim instances ---
# First check PID file
if (Test-Path $pidFile) {
  $oldPid = (Get-Content $pidFile -Raw).Trim()
  try {
    $oldProc = Get-Process -Id $oldPid -ErrorAction SilentlyContinue
    if ($oldProc) {
      Write-Host "Stopping previous shim (PID=$oldPid)..."
      Stop-Process -Id $oldPid -Force
      # /T kills the whole process tree (watchdog + node)
      & taskkill /F /PID $oldPid /T 2>$null | Out-Null
      Start-Sleep -Milliseconds 500
    }
  } catch { }
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# Also check by port as fallback
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Stopping orphan shim on :$Port (PID=$($existing.OwningProcess))..."
  Stop-Process -Id $existing.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
}

# --- 4. Backup settings.json once per day ---
$today = Get-Date -Format 'yyyy-MM-dd'
$backup = Join-Path $backupDir "settings.json.$today.bak"
if (-not (Test-Path $backup)) {
  Copy-Item -Path $settings -Destination $backup
  Write-Host "Backed up settings.json -> $backup"
}

# --- 5. Generate watchdog CMD script ---
# Loop: run node, if it crashes, restart after 3s.
# If pid file is removed (by stop-shim), watchdog exits cleanly.
$watchdogScript = @"
@echo off
setlocal
set SHIM_PORT=$Port
set SHIM_UPSTREAM=$upstream
set PIDFILE=$pidFile
cd /d "$here"

:loop

node shim.js

if not exist "%PIDFILE%" goto end

echo [%date% %time%] shim crashed (exit %errorlevel%), restarting in 3s...>> shim.log
timeout /t 3 >nul
goto loop

:end
exit /b 0
"@
Set-Content -Path $watchdogFile -Value $watchdogScript -Encoding ASCII

# --- 6. Start watchdog in background ---
$proc = Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$watchdogFile`"" -WindowStyle Hidden -PassThru
Start-Sleep -Seconds 2

# Write watchdog PID to file (stop-shim uses this to kill the whole process tree).
"$($proc.Id)" | Set-Content -Path $pidFile -Encoding ASCII

# Verify shim is listening
$up = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $up) {
  Write-Host "ERROR: shim failed to start. Check shim.log."
  exit 1
}

Write-Host ""
Write-Host "=== Shim started in background ==="
Write-Host "  Watchdog PID: $($proc.Id)"
Write-Host "  Node PID:     $($up.OwningProcess)"
Write-Host "  Listen:       $shimUrl"
Write-Host "  Upstream:     $upstream"
Write-Host "  Log:          $here\shim.log"
Write-Host ""
Write-Host "You may close this window. The service runs in the background."
Write-Host "To stop: double-click stop-shim.cmd"

# --- 7. Repoint settings.json (unless -NoEdit) ---
if (-not $NoEdit) {
  if ($cfg.env.ANTHROPIC_BASE_URL -ne $shimUrl) {
    $cfg.env.ANTHROPIC_BASE_URL = $shimUrl
    $json = $cfg | ConvertTo-Json -Depth 10
    $tmp = "$settings.tmp"
    [System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine)
    Move-Item -Path $tmp -Destination $settings -Force
    Write-Host "Updated settings.json: ANTHROPIC_BASE_URL -> $shimUrl"
  } else {
    Write-Host "settings.json already points at shim — no edit needed."
  }
}
