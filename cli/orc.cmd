@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined ORCSPACE_NODE (
  set "NODE_EXE=%ORCSPACE_NODE:"=%"
  "%NODE_EXE%" "%~dp0orc.mjs" %*
) else (
  node "%~dp0orc.mjs" %*
)
