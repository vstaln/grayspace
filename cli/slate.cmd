@echo off
setlocal
if exist "%~dp0..\native\target\release\slate.exe" (
  "%~dp0..\native\target\release\slate.exe" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0slate.mjs" %*
exit /b %ERRORLEVEL%
