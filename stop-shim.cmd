@echo off
REM deepseek-think-fix : stop shim and restore original ANTHROPIC_BASE_URL

setlocal
cd /d "%~dp0"
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-shim.ps1"
echo.
echo Press any key to close...
pause >nul
