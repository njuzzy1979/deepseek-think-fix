@echo off
REM deepseek-think-fix : start shim in background (hidden, no window)

setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0start-shim.ps1"
