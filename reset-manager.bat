@echo off
REM Сбрасывает роль руководителя и снимает все блокировки файлов
REM в запущенном приложении Workspace.
cd /d "%~dp0"
node scripts\reset.mjs --all
echo.
pause
