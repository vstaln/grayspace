@echo off
setlocal
cd /d "%~dp0"
title OrcSpace Linux Installer (Docker)

echo ==========================================================
echo  OrcSpace - Build Linux Installer via Docker
echo ==========================================================
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo  [x] Docker is not installed or not in your PATH.
  echo      Install Docker Desktop from https://www.docker.com/
  echo.
  pause
  exit /b 1
)

if not exist "dist" mkdir "dist"

echo [1/2] Building Linux build container image...
docker build -t orcspace-linux-builder -f Dockerfile.build-linux .
if errorlevel 1 (
  echo.
  echo  [x] Docker build failed. Please ensure Docker Desktop is running.
  echo.
  pause
  exit /b 1
)

echo.
echo [2/2] Compiling and packaging Linux artifacts (AppImage, .deb, .tar.gz)...
docker run --rm -v "%cd%\dist:/app/dist" orcspace-linux-builder
if errorlevel 1 (
  echo.
  echo  [x] Packaging failed inside the Linux container.
  echo.
  pause
  exit /b 1
)

echo.
echo ==========================================================
echo  [ok] Linux installers created in dist\installers\linux\!
echo ==========================================================
dir /b dist\installers\linux\*.AppImage dist\installers\linux\*.deb dist\installers\linux\*.tar.gz 2>nul
echo.
pause
endlocal
