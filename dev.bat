@echo off
setlocal
REM Run OrcSpace Dev with native orc CLI backend.
REM The separate profile avoids single-instance conflicts.
cd /d "%~dp0"
title OrcSpace Dev

set "WORKSPACE_CONTROL_PORT=20220"
set "ORCSPACE_DEV_USER_DATA=%~dp0.dev-user-data"

echo ===========================================================
echo  Starting OrcSpace Dev (Native orc CLI + Orchestration)
echo  Control API: http://127.0.0.1:%WORKSPACE_CONTROL_PORT%
echo ===========================================================
echo.

REM Check if node_modules exists
if not exist "%~dp0node_modules" (
  echo [OrcSpace] Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo [Error] npm install failed.
    pause
    exit /b 1
  )
)

REM Ensure Electron binary is installed
if not exist "%~dp0node_modules\electron\path.txt" (
  echo [OrcSpace] Initializing Electron binary...
  call node "%~dp0node_modules\electron\install.js"
)

REM Build native accelerators if available
call npm.cmd run build:native

REM Terminate any stale background instances holding port 20220
taskkill /f /im OrcSpace.exe >nul 2>&1

call npx.cmd electron-vite dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"

echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
endlocal
