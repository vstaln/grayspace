@echo off
setlocal
cd /d "%~dp0"
title OrcSpace Setup

echo ==========================================================
echo  OrcSpace - Setup and Launcher for Windows
echo ==========================================================
echo.

where node.exe >nul 2>&1
if errorlevel 1 (
  echo  [x] Node.js is not installed or not on your PATH.
  echo      Please install Node.js v20 or higher from https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODE_MAJOR=%%v
if %NODE_MAJOR% LSS 20 (
  echo  [x] Node.js v20 or higher is required. Detected major version %NODE_MAJOR%.
  echo.
  pause
  exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
  echo  [x] npm.cmd is not available on your PATH.
  echo      Reinstall Node.js using the official LTS installer.
  echo.
  pause
  exit /b 1
)

node "%~dp0scripts\setup.mjs" %*
if errorlevel 1 (
  echo.
  echo  [x] Setup failed.
  echo.
  pause
  exit /b 1
)

endlocal
