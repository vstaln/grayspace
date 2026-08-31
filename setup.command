#!/bin/sh
# macOS launcher: one combined control/renderer server.
set -e
cd "$(dirname "$0")"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"
exec node scripts/setup.mjs "$@"
