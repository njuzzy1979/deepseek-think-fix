@echo off
REM deepseek-think-fix : start shim in background (smart auto-detect)
REM After startup you may close this window. Service runs independently.
REM To stop: double-click stop-shim.cmd

setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-shim.ps1"
echo.
echo Press any key to close this window...
pause >nul
