@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if not defined ORCSPACE_NODE goto :no_custom_node
set "NODE_EXE=%ORCSPACE_NODE:"=%"
"%NODE_EXE%" "%~dp0orc.mjs" %*
exit /b %ERRORLEVEL%

:no_custom_node
node "%~dp0orc.mjs" %*
exit /b %ERRORLEVEL%
