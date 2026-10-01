<#
.SYNOPSIS
  OrcSpace Windows PowerShell Setup & Launcher
.DESCRIPTION
  Automates Node.js prerequisite verification, dependency installation,
  native modules compilation, and application startup.
#>
[CmdletBinding()]
param(
  [switch]$Reinstall,
  [switch]$Build,
  [switch]$Reset,
  [switch]$NoStart,
  [switch]$Check,
  [switch]$Help
)

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " OrcSpace — Setup & Launcher (PowerShell)" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

if ($Help) {
  Write-Host "Usage: .\setup.ps1 [-Reinstall] [-Build] [-Reset] [-NoStart] [-Check]" -ForegroundColor Yellow
  exit 0
}

# Verify Node.js
try {
  $nodeVer = & node -v
  Write-Host " [ok] Detected Node.js $nodeVer" -ForegroundColor Green
} catch {
  Write-Host " [x] Node.js is not found on your PATH." -ForegroundColor Red
  Write-Host "     Please install Node.js 22.18.x or 24.x from https://nodejs.org/" -ForegroundColor Yellow
  exit 1
}

$cliArgs = @()
if ($Reinstall) { $cliArgs += '--reinstall' }
if ($Build) { $cliArgs += '--build' }
if ($Reset) { $cliArgs += '--reset' }
if ($NoStart) { $cliArgs += '--no-start' }
if ($Check) { $cliArgs += '--check' }

& node "scripts/setup.mjs" @cliArgs
if ($LASTEXITCODE -ne 0) {
  Write-Host "`n [x] Setup failed with exit code $LASTEXITCODE" -ForegroundColor Red
  exit $LASTEXITCODE
}
