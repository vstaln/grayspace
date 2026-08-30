#!/bin/sh
# macOS launcher: one combined control/renderer server, no sidecar service.
set -e
cd "$(dirname "$0")"
exec node scripts/setup.mjs "$@"
