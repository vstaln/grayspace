@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
if defined ORCSPACE_NODE (
  "%ORCSPACE_NODE%" "%~dp0orc.mjs" %*
) else (
  node "%~dp0orc.mjs" %*
)
