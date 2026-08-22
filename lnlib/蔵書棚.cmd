@echo off
rem Start the library browser and open it in the default browser.
cd /d "%~dp0"
python -m lnlib serve
pause
