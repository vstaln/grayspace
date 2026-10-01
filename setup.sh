#!/usr/bin/env bash
#
# OrcSpace Linux Setup and Launcher
# Automates Node.js prerequisite checks, dependency installation,
# native modules compilation, and application startup.
#
set -e

cd "$(dirname "$0")"

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; cyan=$'\033[36m'; reset=$'\033[0m'
ok()   { printf ' %s[ok]%s %s\n' "$green"  "$reset" "$1"; }
warn() { printf ' %s[!]%s  %s\n' "$yellow" "$reset" "$1"; }
err()  { printf ' %s[x]%s  %s\n' "$red"    "$reset" "$1"; }

printf "%s==========================================================%s\n" "$cyan" "$reset"
printf "%s OrcSpace — Setup and Launcher for Linux%s\n" "$cyan" "$reset"
printf "%s==========================================================%s\n\n" "$cyan" "$reset"

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  err "Node.js is not installed or not on your PATH."
  printf "     Please install Node.js 22.18.x or 24.x from https://nodejs.org/\n\n"
  exit 1
fi

NODE_VER=$(node -v)
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" != "22" ] && [ "$NODE_MAJOR" != "24" ]; then
  warn "Node.js 22.18.x or 24.x is required (detected $NODE_VER)."
  warn "If you run into native module issues, please switch to Node.js 22.18 or 24 (nvm use 22)."
else
  ok "Detected Node.js $NODE_VER"
fi

# Check npm
if ! command -v npm >/dev/null 2>&1; then
  err "npm is not available on your PATH."
  printf "     Please reinstall Node.js using the official LTS installer.\n\n"
  exit 1
fi

# Ensure cli/orc executable permissions
if [ -f "cli/orc" ]; then
  chmod +x "cli/orc" 2>/dev/null || true
fi

# Run setup
exec node "scripts/setup.mjs" "$@"
