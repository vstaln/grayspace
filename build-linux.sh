#!/usr/bin/env bash
#
# Builds the Linux installer for OrcSpace (Electron version).
# Produces AppImage and/or .deb packages.
#
# Usage:
#   ./build-linux.sh             # Builds default targets (AppImage + deb + tar.gz)
#   ./build-linux.sh --appimage  # Builds AppImage only
#   ./build-linux.sh --deb       # Builds Debian/Ubuntu .deb only
#   ./build-linux.sh --all       # Builds AppImage, deb, and tar.gz
#   ./build-linux.sh --skip-ci --dirty
#
set -u -o pipefail

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; cyan=$'\033[36m'; reset=$'\033[0m'
ok()   { printf ' %s[ok]%s %s\n' "$green"  "$reset" "$1"; }
warn() { printf ' %s[!]%s  %s\n' "$yellow" "$reset" "$1"; }
err()  { printf ' %s[x]%s  %s\n' "$red"    "$reset" "$1"; }
step() { printf '\n%s==>%s %s\n' "$bold"   "$reset" "$1"; }
die()  { err "$1"; exit 1; }

cd "$(cd -P "$(dirname "$0")" && pwd)" || die 'Could not enter the script directory.'
[ -f package.json ] || die 'Run this from the OrcSpace repository root.'

printf "\n%s==========================================================%s\n" "$cyan" "$reset"
printf "%s OrcSpace — Linux Installer Build%s\n" "$cyan" "$reset"
printf "%s==========================================================%s\n\n" "$cyan" "$reset"

if [ "$(uname -s)" != "Linux" ]; then
  warn "Host OS is $(uname -s), not Linux."
  warn "Building Linux packages natively requires a Linux environment or Docker."
fi

command -v node >/dev/null 2>&1 || die 'Node.js not found. Please install Node.js 22.18.x or 24.x from https://nodejs.org/'

NODE_VER=$(node -v)
NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
if [ "$NODE_MAJOR" != "22" ] && [ "$NODE_MAJOR" != "24" ]; then
  warn "Node.js 22.18.x or 24.x is required (detected $NODE_VER)."
fi

command -v npm >/dev/null 2>&1 || die 'npm is not available on PATH.'

step 'Dependencies'
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok 'App dependencies present.'
else
  printf ' Installing dependencies (npm ci)...\n'
  npm ci --no-fund --no-audit || die 'npm ci failed.'
fi

step 'Building Linux Installer'
node scripts/build-installer-linux.mjs "$@"
[ $? -eq 0 ] || die 'Linux installer build failed — see the log above.'

step 'Generated Artifacts'
ls -lh dist/installers/linux/*.AppImage dist/installers/linux/*.deb dist/installers/linux/*.tar.gz 2>/dev/null | sed 's/^/  /' || warn 'Nothing found in dist/installers/linux/ — check build log above.'

printf "\n%sInstallation instructions:%s\n" "$bold" "$reset"
printf "  • %sAppImage (portable):%s\n" "$green" "$reset"
printf "      chmod +x dist/installers/linux/*.AppImage\n"
printf "      ./dist/installers/linux/*.AppImage\n"
printf "  • %sDebian / Ubuntu / Mint (.deb):%s\n" "$green" "$reset"
printf "      sudo dpkg -i dist/installers/linux/*.deb || sudo apt-get install -f\n"
printf "      orcspace &\n\n"
