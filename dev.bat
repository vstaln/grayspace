@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title OrcSpace Dev

set "WORKSPACE_CONTROL_PORT=20224"
set "ORCSPACE_DEV_USER_DATA=%~dp0.dev-user-data"

echo ===========================================================
echo  Starting OrcSpace Dev (Isolated ^& Coexists with Production)
echo  Control API: http://127.0.0.1:%WORKSPACE_CONTROL_PORT%
echo  Data Directory: %ORCSPACE_DEV_USER_DATA%
echo ===========================================================
echo.

REM Verify Node.js is installed and available
where node.exe >nul 2>&1
if errorlevel 1 (
  echo [Error] Node.js is not found on your PATH.
  echo Please install Node.js v20+ from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

REM node-pty ships prebuilds for Node 20-24, not Node 25+.
REM Bootstrap a cached Node 22 runtime through npx when a newer system Node
REM is selected, then put it first on PATH so npm lifecycle scripts use it too.
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node"') do set "ORC_NODE_MAJOR=%%V"
if !ORC_NODE_MAJOR! GEQ 25 (
  echo [OrcSpace] Node !ORC_NODE_MAJOR! detected; using compatible Node 22 runtime...
  for /f "delims=" %%N in ('npx.cmd --yes node@22.14.0 -p "process.execPath" 2^>nul') do set "ORC_NODE=%%N"
  if not defined ORC_NODE (
    echo [Error] Could not provision Node 22 through npx.
    echo.
    pause
    exit /b 1
  )
  for %%D in ("!ORC_NODE!") do set "ORC_NODE_DIR=%%~dpD"
  set "PATH=!ORC_NODE_DIR!;!PATH!"
)

REM Check the real entry points, not only .bin shims. A failed npm install can
REM leave a wrapper behind while its electron/electron-vite target is missing.
if not exist "%~dp0node_modules\.bin\electron-vite.cmd" goto install_deps
if not exist "%~dp0node_modules\electron-vite\bin\electron-vite.js" goto install_deps
if not exist "%~dp0node_modules\electron\install.js" goto install_deps
goto deps_ready

:install_deps
  echo [OrcSpace] Installing dependencies...
  call npm.cmd install --no-fund --no-audit
  if errorlevel 1 (
    echo [Error] npm install failed.
    echo.
    pause
    exit /b 1
  )

:deps_ready
if not exist "%~dp0node_modules\.bin\electron-vite.cmd" (
  echo [Error] electron-vite is missing after dependency installation.
  echo Close any running OrcSpace/Electron process and run dev.bat again.
  echo.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\electron-vite\bin\electron-vite.js" (
  echo [Error] electron-vite installation is incomplete.
  echo Close any running OrcSpace/Electron process and run dev.bat again.
  echo.
  pause
  exit /b 1
)
if not exist "%~dp0node_modules\electron\install.js" (
  echo [Error] Electron installation is incomplete.
  echo Close any running OrcSpace/Electron process and run dev.bat again.
  echo.
  pause
  exit /b 1
)

REM Ensure Electron binary is installed
if not exist "%~dp0node_modules\electron\path.txt" (
  echo [OrcSpace] Initializing Electron binary...
  call node "%~dp0node_modules\electron\install.js"
)

REM Fast native accelerators verification (skips rebuild if already compiled)
call node "%~dp0native\build.mjs"

REM Launch Electron Dev server directly using local binary
REM This runs Vite and spawns the visible Electron dev window
call "%~dp0node_modules\.bin\electron-vite.cmd" dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"

echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
endlocal
