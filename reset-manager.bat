@echo off
REM Releases the manager role and drops every file lock in a running
REM OrcSpace app.
cd /d "%~dp0"
node scripts\reset.mjs --all
echo.
pause
