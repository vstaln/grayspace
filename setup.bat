@echo off
setlocal EnableExtensions EnableDelayedExpansion
cd /d "%~dp0"
title OrcSpace Setup
chcp 65001 >nul

echo.
echo  OrcSpace Setup  -  backend :20220 (Control + MCP)  (no Dashboard)
echo  -----------------------------------------------------------
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [x] Node.js not found. Install Node LTS and run setup again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo  [x] npm not found. Install Node LTS ^(npm ships with it^) and run again.
  pause
  exit /b 1
)

for /f "tokens=*" %%v in ('node -v 2^>nul') do set NODE_V=%%v
echo  [ok] Node !NODE_V!  npm %npm_config_user_agent:*/=%
echo.

:: --- deps: App ---------------------------------------------------------
if not exist "node_modules\" (
  echo  Installing app dependencies...
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo  [x] npm install failed in Orcspace.
    pause
    exit /b 1
  )
) else (
  echo  [ok] App dependencies present.
)

:: --- deps: MCP sibling -------------------------------------------------
if exist "Orcspace-mcp\package.json" (
  if not exist "Orcspace-mcp\node_modules\" (
    echo  Installing MCP dependencies...
    call npm --prefix "Orcspace-mcp" install --no-fund --no-audit
    if errorlevel 1 (
      echo  [!] npm install failed in Orcspace-mcp - MCP may not be packaged.
    )
  ) else (
    echo  [ok] MCP dependencies present.
  )
  echo  Building MCP...
  call npm --prefix "Orcspace-mcp" run build
  if errorlevel 1 (
    echo  [!] MCP build failed - rebuild later with: npm run build:mcp
  ) else (
    echo  [ok] MCP built.
  )
) else (
  echo  [!] Orcspace-mcp folder not found - skipping MCP; the app still starts.
)

:: --- native (best-effort, TS fallback exists) ------------------------
echo  Building native crates ^(best-effort^)...
call npm run build:native
if errorlevel 1 echo  [!] native build skipped - the fallback takes over.

:: --- already alive? ----------------------------------------------------
call :alive
if not errorlevel 1 (
  echo.
  echo  [ok] The app is already live on :20220 - no second instance needed.
  echo       To restart, close the app window and run setup again.
  goto check_mcp
)

:: --- launch App (dev) --------------------------------------------------
echo.
echo  Starting the app ^(Electron + backend :20220^)...
start "OrcSpace App" /D "%~dp0" cmd /k "title OrcSpace App && npm run dev"

echo  Waiting for http://127.0.0.1:20220/presence ...
set /a n=0
:wait
set /a n+=1
call :alive
if not errorlevel 1 goto check_mcp
if %n% geq 40 (
  echo  [!] The app is still starting ^(>80s^) - check the "OrcSpace App" window for errors.
  goto check_mcp
)
timeout /t 2 /nobreak >nul
goto wait

:check_mcp
:: --- verify MCP --------------------------------------------------------
echo.
echo  Checking MCP :20220/mcp ...
node -e "fetch('http://127.0.0.1:20220/mcp',{method:'GET',signal:AbortSignal.timeout(1500)}).then(r=>{console.log(r.ok||r.status===406||r.status===404?'  [ok] MCP answers (status '+r.status+')':'  [!] MCP status '+r.status);process.exit(0)}).catch(()=>{console.log('  [..] MCP is still coming up with the app.');process.exit(0)})"
node -e "fetch('http://127.0.0.1:20220/presence',{signal:AbortSignal.timeout(1200)}).then(r=>r.json()).then(j=>{console.log('  App presence: pid '+j.pid+'  mcpRunning='+j.mcpRunning+'  dir='+(j.workspaceDir||'(no folder)'));}).catch(()=>{console.log('  [!] /presence did not answer - the app is still loading.')})"

echo.
echo  Done. App + MCP start automatically; the Dashboard is disabled.
echo  Keep the "OrcSpace App" window open. MCP logs appear there too.
echo.
exit /b 0

:alive
node -e "fetch('http://127.0.0.1:20220/presence',{signal:AbortSignal.timeout(900)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
exit /b %errorlevel%
