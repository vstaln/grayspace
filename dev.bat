@echo off
setlocal
REM Run OrcSpace Dev alongside the installed version.
REM The separate profile avoids the single-instance conflict, while the
REM Dev uses one backend port for Control and MCP.
cd /d "%~dp0"
title OrcSpace Dev

set "WORKSPACE_CONTROL_PORT=20220"
set "ORCSPACE_DEV_USER_DATA=%~dp0.dev-user-data"

echo Starting OrcSpace Dev...
echo Control: http://127.0.0.1:%WORKSPACE_CONTROL_PORT%
echo MCP:     http://127.0.0.1:%WORKSPACE_CONTROL_PORT%/mcp
echo.

REM Run electron-vite directly so predev does not try to modify the
REM MCP runtime is part of this repository under Orcspace-mcp.
call npx.cmd electron-vite dev -- --user-data-dir="%ORCSPACE_DEV_USER_DATA%"

echo.
if errorlevel 1 (
  echo Dev server exited with an error.
  pause
)
endlocal
