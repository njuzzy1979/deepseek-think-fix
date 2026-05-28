# deepseek-think-fix — stop the shim AND watchdog cleanly, never auto-restart.
#
# Stop order is critical:
#   1. Remove the PID file FIRST. The watchdog reads this file between node
#      restarts; if it's gone, the watchdog exits cleanly on its own.
#   2. Kill the recorded watchdog PID's full process tree (cmd + node child).
#   3. Fallback: hunt for any orphan `.watchdog.cmd` cmd.exe processes by
#      command-line search and kill them too — this covers the case where
#      the PID file is missing/stale.
#   4. Fallback: kill anything still listening on :8788.
#   5. Verify the port is released, retry once if not.
#   6. Clean up generated files and restore ANTHROPIC_BASE_URL.

[CmdletBinding()]
param([int]$Port = 8788)

$ErrorActionPreference = 'Continue'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$settings = Join-Path $env:USERPROFILE '.claude\settings.json'
$shimUrl  = "http://127.0.0.1:$Port"
$pidFile  = Join-Path $here '.shim-pid.txt'
$watchdogFile = Join-Path $here '.watchdog.cmd'
$lastUpstreamFile = Join-Path $here 'backups\last-upstream.txt'

$killed = $false

# --- Step 1: Remove PID file FIRST so watchdog exits cleanly on next check.
$shimPid = $null
if (Test-Path $pidFile) {
  $shimPid = (Get-Content $pidFile -Raw).Trim()
  Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
}

# --- Step 2: Kill recorded watchdog PID (whole process tree: cmd + node).
if ($shimPid -and ($shimPid -match '^\d+$')) {
  Write-Host "Stopping watchdog tree (PID=$shimPid)..."
  & taskkill /F /PID $shimPid /T 2>$null | Out-Null
  Start-Sleep -Milliseconds 500
  $still = Get-Process -Id $shimPid -ErrorAction SilentlyContinue
  if ($still) {
    Stop-Process -Id $shimPid -Force -ErrorAction SilentlyContinue
    Start-Sleep -Milliseconds 200
  }
  $killed = $true
}

# --- Step 3: Hunt orphan watchdog cmd.exe by command-line match.
#     Covers: PID file lost, stale, or watchdog spawned outside our knowledge.
try {
  $watchdogCmds = Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and ($_.CommandLine -like "*$($watchdogFile -replace '\\','\\')*" -or $_.CommandLine -like '*.watchdog.cmd*') }
  foreach ($p in $watchdogCmds) {
    Write-Host "Killing orphan watchdog (PID=$($p.ProcessId))..."
    & taskkill /F /PID $p.ProcessId /T 2>$null | Out-Null
    $killed = $true
  }
} catch { }

# --- Step 4: Kill anything still listening on :$Port (orphan node).
$conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($conn) {
  foreach ($c in @($conn)) {
    Write-Host "Killing orphan listener on :$Port (PID=$($c.OwningProcess))..."
    Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue
    $killed = $true
  }
  Start-Sleep -Milliseconds 500
}

# --- Step 5: Verify port is released.
$final = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($final) {
  Write-Host "Port :$Port still in use after stop (PID=$($final.OwningProcess)) — retry forcing..."
  Stop-Process -Id $final.OwningProcess -Force -ErrorAction SilentlyContinue
  Start-Sleep -Milliseconds 500
  $final = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
}
if (-not $final) {
  Write-Host "Port :$Port released."
} else {
  Write-Warning "Port :$Port STILL in use by PID=$($final.OwningProcess) after all attempts."
}

# --- Step 6: Clean up generated files.
Remove-Item $watchdogFile -Force -ErrorAction SilentlyContinue
$runShimCmd = Join-Path $here '.run-shim.cmd'
Remove-Item $runShimCmd -Force -ErrorAction SilentlyContinue

if (-not $killed -and -not $final) {
  Write-Host "No shim process found."
}

# --- Step 7: Restore BASE_URL.
if ((Test-Path $settings) -and (Test-Path $lastUpstreamFile)) {
  $cfg = Get-Content $settings -Raw | ConvertFrom-Json
  $cur = $cfg.env.ANTHROPIC_BASE_URL
  if ($cur -eq $shimUrl) {
    $orig = (Get-Content $lastUpstreamFile -Raw).Trim()
    $cfg.env.ANTHROPIC_BASE_URL = $orig
    $json = $cfg | ConvertTo-Json -Depth 10
    $tmp = "$settings.tmp"
    [System.IO.File]::WriteAllText($tmp, $json + [Environment]::NewLine)
    Move-Item -Path $tmp -Destination $settings -Force
    Write-Host "Restored ANTHROPIC_BASE_URL -> $orig"
  } else {
    Write-Host "settings.json BASE_URL is '$cur' (not the shim) — leaving as-is."
  }
}

Write-Host "Done. The service will NOT auto-restart. Use start-shim.cmd to start again."
