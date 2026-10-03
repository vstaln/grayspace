@echo off
setlocal
if exist "%~dp0..\native\target\release\grayspace.exe" (
  "%~dp0..\native\target\release\grayspace.exe" %*
  exit /b %ERRORLEVEL%
)
node "%~dp0grayspace.mjs" %*
exit /b %ERRORLEVEL%
