@echo off
rem Double-click shortcut for start.ps1.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
