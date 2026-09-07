@echo off
setlocal
cd /d "%~dp0"
title OrcSpace Dev

set "WORKSPACE_CONTROL_PORT=20224"
set "ORCSPACE_DEV_USER_DATA=%~dp0.dev-user-data"

echo ===========================================================
echo  Starting OrcSpace Dev (Isolated ^& Coexists with Production)
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

REM Do NOT kill OrcSpace.exe! The regular app and dev can run simultaneously.

call npx.cmd electron-vite dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"

echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
endlocal
