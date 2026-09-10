@echo off
setlocal
cd /d "%~dp0"
title OrcSpace Windows Installer

where node.exe >nul 2>&1
if errorlevel 1 (
  echo [x] Node.js 20-24 is required to build the installer.
  echo     Install the current Node.js LTS release and run this file again.
  exit /b 1
)

node "%~dp0scripts\build-installer.mjs" %*
if errorlevel 1 (
  echo.
  echo [x] Installer build failed.
  exit /b 1
)

echo.
echo [ok] Installer is in the dist folder.
endlocal
