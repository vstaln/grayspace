@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title OrcSpace Dev

set "WORKSPACE_CONTROL_PORT=20224"
set "ORCSPACE_DEV_USER_DATA=%~dp0.dev-user-data"

REM Usage: dev.bat [--fast] [--full] [--skip-native]
REM   --fast         skip the native rebuild check (fastest start)
REM   --skip-native  same as --fast
REM   --full         force dependency + native rebuild checks (slowest, most thorough)
set "ORC_FAST=0"
set "ORC_FULL=0"
for %%A in (%*) do (
  if /i "%%~A"=="--fast" set "ORC_FAST=1"
  if /i "%%~A"=="--skip-native" set "ORC_FAST=1"
  if /i "%%~A"=="--full" set "ORC_FULL=1"
  if /i "%%~A"=="--help" goto usage
  if /i "%%~A"=="-h" goto usage
)
goto startup

:usage
  echo Usage: dev.bat [--fast] [--full] [--skip-native]
  echo   --fast         skip the native rebuild step (fastest start)
  echo   --skip-native  same as --fast
  echo   --full         force dependency + native rebuild checks
  echo Environment: ORCSPACE_SKIP_NATIVE=1 also skips the native rebuild step.
  endlocal
  exit /b 0

:startup
echo ===========================================================
echo  Starting OrcSpace Dev (Isolated ^& Coexists with Production)
echo  Control API: http://127.0.0.1:%WORKSPACE_CONTROL_PORT%
echo  Data Directory: %ORCSPACE_DEV_USER_DATA%
echo ===========================================================
echo.

REM Single Node probe (version check doubles as the "is node installed" check).
for /f "tokens=1 delims=." %%V in ('node -p "process.versions.node" 2^>nul') do set "ORC_NODE_MAJOR=%%V"
if not defined ORC_NODE_MAJOR (
  echo [Error] Node.js is not found on your PATH.
  echo Please install Node.js v20+ from https://nodejs.org/ and try again.
  echo.
  pause
  exit /b 1
)

REM node-pty ships prebuilds for Node 20-24, not Node 25+.
REM Use a persistent portable Node 22 runtime when a newer system Node is
REM selected, then put it first on PATH so npm lifecycle scripts use it too.
REM The runtime lives in %LOCALAPPDATA%\Orcspace\node22 and is downloaded once
REM (official nodejs.org zip); every later launch is just an `if exist` check.
set "ORC_NODE22_VERSION=22.14.0"
if !ORC_NODE_MAJOR! GEQ 25 (
  set "ORC_NODE=%LOCALAPPDATA%\Orcspace\node22\node-v!ORC_NODE22_VERSION!-win-x64\node.exe"
  if not exist "!ORC_NODE!" (
    echo [OrcSpace] Node !ORC_NODE_MAJOR! detected; downloading compatible Node !ORC_NODE22_VERSION! runtime ^(one-time^)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "New-Item -ItemType Directory -Force -Path $env:LOCALAPPDATA\Orcspace\node22 | Out-Null; Invoke-WebRequest -Uri https://nodejs.org/dist/v!ORC_NODE22_VERSION!/node-v!ORC_NODE22_VERSION!-win-x64.zip -OutFile $env:TEMP\node22.zip; Expand-Archive -Force -Path $env:TEMP\node22.zip -DestinationPath $env:LOCALAPPDATA\Orcspace\node22"
    if not exist "!ORC_NODE!" (
      echo [Error] Could not download Node !ORC_NODE22_VERSION! from nodejs.org.
      echo.
      pause
      exit /b 1
    )
  )
  for %%D in ("!ORC_NODE!") do set "ORC_NODE_DIR=%%~dpD"
  set "PATH=!ORC_NODE_DIR!;!PATH!"
)

REM Check the real entry points, not only .bin shims. A failed npm install can
REM leave a wrapper behind while its electron/electron-vite target is missing.
set "ORC_JUST_INSTALLED=0"
if not exist "%~dp0node_modules\.bin\electron-vite.cmd" goto install_deps
if not exist "%~dp0node_modules\electron-vite\bin\electron-vite.js" goto install_deps
if not exist "%~dp0node_modules\electron\install.js" goto install_deps
goto deps_ready

:install_deps
  echo [OrcSpace] Installing dependencies...
  call npm.cmd install --no-fund --no-audit --prefer-offline --no-progress
  if errorlevel 1 (
    echo [Error] npm install failed.
    echo.
    pause
    exit /b 1
  )
  set "ORC_JUST_INSTALLED=1"

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

REM ---- Fast native accelerators check (skips the slow rebuild when possible) ----
REM native/build.mjs recompiles both napi crates, which costs tens of seconds.
REM Skip it when any of these is true (unless --full forces a rebuild attempt):
REM   * --fast / --skip-native / ORCSPACE_SKIP_NATIVE=1 was requested
REM   * both crates already have a matching prebuilt .node (up to date)
REM   * the PTY addon exists but no MSVC linker is present, so the napi build
REM     would deterministically fail and fall back to TypeScript anyway
REM A fresh npm install in this session always runs the full step once, because
REM postinstall aside, the conpty runtime pair must be verified after install.
if %ORC_FULL%==1 goto run_native
if %ORC_FAST%==1 (
  echo [OrcSpace] Skipping native rebuild ^(--fast^).
  goto launch
)
if /i "%ORCSPACE_SKIP_NATIVE%"=="1" (
  echo [OrcSpace] Skipping native rebuild ^(ORCSPACE_SKIP_NATIVE=1^).
  goto launch
)
if %ORC_JUST_INSTALLED%==1 goto run_native
if exist "%~dp0native\canvas-core\*win32-x64*.node" if exist "%~dp0native\storage-core\*win32-x64*.node" goto launch
if not exist "%~dp0node_modules\@homebridge\node-pty-prebuilt-multiarch\build\Release\conpty.node" goto run_native
where link.exe >nul 2>&1
if errorlevel 1 (
  echo [OrcSpace] No MSVC linker ^(link.exe^) found; skipping native rebuild.
  echo            TypeScript fallbacks will be used. Install VS Build Tools ^(C++^)
  echo            or run dev.bat --full to force a build attempt.
  goto launch
)

:run_native
call node "%~dp0native\build.mjs"

:launch
REM Quieter/faster renderer boot: no per-warning overhead, no security nag.
set "ELECTRON_DISABLE_SECURITY_WARNINGS=true"
set "NODE_NO_WARNINGS=1"

REM Launch Electron Dev server directly through node instead of the .bin
REM shim to avoid an extra cmd layer; fall back to the shim if needed.
REM This runs Vite and spawns the visible Electron dev window.
if exist "%~dp0node_modules\electron-vite\bin\electron-vite.js" (
  node "%~dp0node_modules\electron-vite\bin\electron-vite.js" dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"
) else (
  call "%~dp0node_modules\.bin\electron-vite.cmd" dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"
)

echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
endlocal
