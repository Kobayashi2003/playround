@echo off
rem Start the library browser and open it in the default browser.
pwsh -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1" %*
pause
