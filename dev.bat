@echo off
REM Запуск OrcSpace в режиме разработки (npm run dev)
cd /d "%~dp0"
title OrcSpace Dev
echo Starting OrcSpace dev server...
echo.
call npm run dev
echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
