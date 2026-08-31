#!/bin/bash
#
# Builds the macOS app. Double-click in Finder, or `./build-mac.command`.
#
# This has to run on a Mac: electron-builder refuses macOS targets on Windows
# and Linux, because a .app bundle needs symlinks and a case-sensitive layout
# only macOS reliably provides. There is no cross-build workaround.
#
# The default output is a .zip of OrcSpace.app for this Mac's own architecture —
# the smallest thing that installs (unzip, drag to Applications). Pass --dmg for
# a disk image instead, or --all for every architecture and both formats.

set -u -o pipefail

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'
ok()   { printf ' %s[ok]%s %s\n' "$green"  "$reset" "$1"; }
warn() { printf ' %s[!]%s  %s\n' "$yellow" "$reset" "$1"; }
err()  { printf ' %s[x]%s  %s\n' "$red"    "$reset" "$1"; }
step() { printf '\n%s==>%s %s\n' "$bold"   "$reset" "$1"; }

KEEP_OPEN=0
case "${TERM_PROGRAM:-}" in
  Apple_Terminal|iTerm.app) [ -t 0 ] && KEEP_OPEN=1 ;;
esac
finish() {
  if [ "$KEEP_OPEN" = "1" ]; then
    printf '\n%sPress Enter to close this window.%s ' "$dim" "$reset"
    read -r _ || true
  fi
  exit "$1"
}
die() { err "$1"; finish 1; }

cd "$(cd -P "$(dirname "$0")" && pwd)" || die 'Could not enter the script directory.'
[ -f package.json ] || die 'Run this from the OrcSpace repository root.'

# Add common PATHs for macOS environments (Homebrew arm64/x64, NVM, Volta, FNM)
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"

[ "$(uname -s)" = "Darwin" ] || die "macOS is required to build a Mac app; this is $(uname -s)."
command -v node >/dev/null 2>&1 || die 'Node.js not found. Install Node LTS: brew install node (or from https://nodejs.org)'
xcode-select -p >/dev/null 2>&1 || die 'Xcode Command Line Tools missing. Run: xcode-select --install'

MODE="dmg"
for arg in "$@"; do
  case "$arg" in
    --dmg) MODE="dmg" ;;
    --zip) MODE="zip" ;;
    --universal) MODE="universal" ;;
    --all) MODE="all" ;;
    *) die "Unknown option: $arg (expected --dmg, --zip, --universal or --all)" ;;
  esac
done

ARCH="$(uname -m)"
printf '\n %sOrcSpace — macOS build%s\n' "$bold" "$reset"
printf ' Host: %s   Output: %s\n' "$ARCH" "$MODE"
printf ' %s\n' "──────────────────────────────────────────────────────────"

step 'Dependencies'
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok 'App dependencies present.'
else
  printf ' Installing dependencies (npm ci)...\n'
  npm ci --no-fund --no-audit || die 'npm ci failed.'
fi

step 'Building Installer'
case "$MODE" in
  dmg)
    if [ "$ARCH" = "arm64" ]; then
      npm run dist:mac:arm
    else
      npm run dist:mac:intel
    fi
    ;;
  zip)
    if [ "$ARCH" = "arm64" ]; then
      npm run dist:mac:arm
    else
      npm run dist:mac:intel
    fi
    ;;
  universal)
    npm run dist:mac:universal
    ;;
  all)
    npm run dist:mac
    ;;
esac
[ $? -eq 0 ] || die 'The build failed — see the output above.'

step 'Result'
ls -lh dist/*.zip dist/*.dmg 2>/dev/null | sed 's/^/  /' || warn 'Nothing in dist/ — check the log above.'

# The build is unsigned: without a $99/yr Apple Developer ID there is no
# certificate to sign with, and Gatekeeper blocks unsigned apps by default.
# Stripping the quarantine attribute is the supported way to run your own build.
printf '\n %sThe build is unsigned.%s To open it on this Mac:\n' "$yellow" "$reset"
printf '   1. Unzip and move OrcSpace.app to /Applications\n'
printf '   2. %sxattr -cr /Applications/OrcSpace.app%s\n' "$dim" "$reset"
printf '   3. Launch it normally\n'
printf ' Without step 2 macOS says the app "is damaged" — that is Gatekeeper,\n'
printf ' not a broken build. Signing + notarization removes the step for others.\n'
finish 0
