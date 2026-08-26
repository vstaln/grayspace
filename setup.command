#!/bin/bash
#
# OrcSpace Setup — macOS
#
# Double-click in Finder, or run `./setup.command` / `bash setup.command`.
# The Windows path lives separately in setup.bat and is untouched by this script.
#
# What it does:
#   1. Checks Node (>=20), the Xcode Command Line Tools and — optionally — Rust.
#   2. Installs the app's and Orcspace-mcp's dependencies and builds MCP.
#   3. Builds the native crates (not critical: TypeScript fallbacks exist).
#   4. Starts the app. MCP is embedded in the single backend on :20220
#      (src/main/embeddedMcp.ts) — there is no separate process to start.
#   5. Verifies that Control :20220 and MCP /mcp really answer.

set -u -o pipefail

APP_PORT="${WORKSPACE_CONTROL_PORT:-20220}"
MCP_PORT="$APP_PORT"
MIN_NODE_MAJOR=20

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; green=$'\033[32m'; yellow=$'\033[33m'; reset=$'\033[0m'

ok()   { printf ' %s[ok]%s %s\n'  "$green"  "$reset" "$1"; }
warn() { printf ' %s[!]%s  %s\n'  "$yellow" "$reset" "$1"; }
err()  { printf ' %s[x]%s  %s\n'  "$red"    "$reset" "$1"; }
step() { printf '\n%s==>%s %s\n'  "$bold"   "$reset" "$1"; }

# A double-click from Finder closes the window together with the process, taking
# any error message with it. Hold the window open until the user presses Enter.
KEEP_OPEN=0
case "${TERM_PROGRAM:-}" in
  Apple_Terminal|iTerm.app) [ -t 0 ] && KEEP_OPEN=1 ;;
esac

finish() {
  local code=$1
  if [ "$KEEP_OPEN" = "1" ]; then
    printf '\n%sPress Enter to close this window.%s ' "$dim" "$reset"
    read -r _ || true
  fi
  exit "$code"
}

die() { err "$1"; finish 1; }

printf '\n %sOrcSpace Setup — macOS%s\n' "$bold" "$reset"
printf ' App :%s  +  MCP :%s  (the app starts MCP itself)\n' "$APP_PORT" "$MCP_PORT"
printf ' %s\n' "──────────────────────────────────────────────────────────"

# ---- 0. locate the repository ---------------------------------------------
# The script lives both in the repo root and as a copied shortcut (Desktop,
# Downloads), so the app directory is searched for rather than assumed. The test
# is specifically `"name": "orcspace"` in package.json: Orcspace-mcp sits next to
# it with a similar folder name, and without that check the installer could go
# and build the wrong project. ORCSPACE_DIR overrides the search.
is_repo() { [ -f "$1/package.json" ] && grep -q '"name"[[:space:]]*:[[:space:]]*"orcspace"' "$1/package.json" 2>/dev/null; }

find_repo() {
  local self_dir candidate
  # `cd -P` rather than readlink -f: BSD readlink has no -f, and a symlink to
  # setup.command (the usual shape of a shortcut) would otherwise resolve to
  # its own copy.
  self_dir="$(cd -P "$(dirname "$0")" 2>/dev/null && pwd)" || return 1

  if [ -n "${ORCSPACE_DIR:-}" ]; then
    if is_repo "$ORCSPACE_DIR"; then printf '%s' "$ORCSPACE_DIR"; return 0; fi
    err "ORCSPACE_DIR=$ORCSPACE_DIR — no OrcSpace there." >&2
    return 1
  fi

  # Next to the script, then up the tree (a copy inside a subfolder of the
  # repo), then the usual places people copy it to.
  is_repo "$self_dir" && { printf '%s' "$self_dir"; return 0; }
  candidate="$self_dir"
  while [ "$candidate" != "/" ] && [ -n "$candidate" ]; do
    candidate="$(dirname "$candidate")"
    is_repo "$candidate" && { printf '%s' "$candidate"; return 0; }
  done
  for candidate in "$self_dir/Orcspace" "$HOME/Desktop/Orcspace" "$HOME/Orcspace" \
                   "$HOME/Documents/Orcspace" "$HOME/Downloads/Orcspace" \
                   "$HOME/Developer/Orcspace" "$HOME/projects/Orcspace"; do
    is_repo "$candidate" && { printf '%s' "$candidate"; return 0; }
  done
  return 1
}

REPO_DIR="$(find_repo)" || REPO_DIR=""
if [ -z "$REPO_DIR" ]; then
  err 'Could not find the OrcSpace folder.'
  printf '     Put setup.command in the repository root, or name the path:\n'
  printf '       %sORCSPACE_DIR=~/path/to/Orcspace ./setup.command%s\n' "$dim" "$reset"
  finish 1
fi
cd "$REPO_DIR" || die "Could not enter $REPO_DIR"
MCP_DIR="$REPO_DIR/Orcspace-mcp"
ok "Repository: $REPO_DIR"

# ---- 1. preflight ---------------------------------------------------------
step 'Checking the environment'

if [ "$(uname -s)" != "Darwin" ]; then
  die "This is the macOS installer, but the system is $(uname -s). On Windows run setup.bat."
fi

if ! command -v node >/dev/null 2>&1; then
  err 'Node.js not found.'
  printf '     Install Node LTS and run setup again:\n'
  printf '       brew install node        %s(or download it from nodejs.org)%s\n' "$dim" "$reset"
  finish 1
fi
if ! command -v npm >/dev/null 2>&1; then
  die 'npm not found — reinstall Node LTS (npm ships with it).'
fi

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(printf '%s' "$NODE_VERSION" | sed 's/^v//' | cut -d. -f1)"
if ! printf '%s' "$NODE_MAJOR" | grep -Eq '^[0-9]+$' || [ "$NODE_MAJOR" -lt "$MIN_NODE_MAJOR" ]; then
  die "Node >= ${MIN_NODE_MAJOR} is required, ${NODE_VERSION} is installed. Update it: brew upgrade node"
fi
ok "Node ${NODE_VERSION}, npm $(npm -v)"

# node-pty and napi-rs compile natively: without the Command Line Tools, npm
# install dies halfway through with an opaque linker error.
if ! xcode-select -p >/dev/null 2>&1; then
  err 'The Xcode Command Line Tools are not installed — native modules cannot build.'
  printf '     Install them (a macOS dialog opens) and run setup again:\n'
  printf '       xcode-select --install\n'
  finish 1
fi
ok "Command Line Tools: $(xcode-select -p)"

# Apple Silicon under Rosetta: Node would build x64 bindings for an arm64
# Electron, and loading the native modules would fail at runtime with
# "mach-o file, but is an incompatible architecture".
HOST_ARCH="$(uname -m)"
NODE_ARCH="$(node -p 'process.arch')"
if [ "$HOST_ARCH" = "arm64" ] && [ "$NODE_ARCH" = "x64" ]; then
  warn 'Node is running as x64 under Rosetta on Apple Silicon.'
  printf '     Native modules would be built for x64 and may fail to load.\n'
  printf '     Better to install an arm64 Node: %sarch -arm64 brew install node%s\n' "$dim" "$reset"
else
  ok "Architecture: ${HOST_ARCH} (node ${NODE_ARCH})"
fi

if command -v cargo >/dev/null 2>&1; then
  ok "Rust: $(cargo --version)"
else
  warn 'Rust (cargo) not found — the native accelerators fall back to TypeScript.'
  printf '     Not a blocker. If you want the Rust crates: %sbrew install rust%s\n' "$dim" "$reset"
fi

# ---- 2. app dependencies --------------------------------------------------
step 'App dependencies'
if [ -d node_modules ] && [ -f node_modules/.package-lock.json ]; then
  ok 'App dependencies are already installed.'
else
  printf ' Installing app dependencies (slow the first time)...\n'
  npm ci --no-fund --no-audit || die 'npm ci failed in Orcspace.'
  ok 'App dependencies installed.'
fi

# ---- 3. MCP: dependencies and build ---------------------------------------
step 'MCP server'
if [ -f "$MCP_DIR/package.json" ]; then
  if [ -d "$MCP_DIR/node_modules" ] && [ -f "$MCP_DIR/node_modules/.package-lock.json" ]; then
    ok 'MCP dependencies are already installed.'
  else
    printf ' Installing MCP dependencies...\n'
    npm --prefix "$MCP_DIR" ci --no-fund --no-audit \
      || warn 'npm ci failed in Orcspace-mcp — its dependencies are needed to package the app.'
  fi
  printf ' Building MCP...\n'
  if npm --prefix "$MCP_DIR" run build; then
    ok 'MCP built.'
  else
    warn 'The MCP build failed — you can rebuild it later with: npm run build:mcp'
  fi
else
  warn "Folder $MCP_DIR not found — skipping MCP; the app still starts."
fi

# ---- 4. native (best-effort) ----------------------------------------------
step 'Native crates (best-effort)'
if npm run build:native; then
  ok 'Native step finished.'
else
  warn 'The native build was skipped — the TypeScript fallback takes over.'
fi

# ---- 5. start the app -----------------------------------------------------
# The live instance's port, not pgrep: it is the only real sign that "the app is
# actually serving requests", and the same check is reused below.
app_alive() {
  node -e "fetch('http://127.0.0.1:${APP_PORT}/presence',{signal:AbortSignal.timeout(900)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1
}

step 'Starting'
if app_alive; then
  ok "The app is already live on :${APP_PORT} — no second instance needed."
  printf ' %sTo restart: quit OrcSpace and run setup again.%s\n' "$dim" "$reset"
else
  printf ' Starting the app in the background (Electron + control :%s + MCP :%s)...\n' "$APP_PORT" "$MCP_PORT"
  mkdir -p .staging
  LOG_FILE=".staging/setup-dev.log"
  # nohup plus a setsid-like detach: the Terminal window can be closed and the
  # app keeps running. Logs go to a file so they can still be read.
  nohup npm run dev >"$LOG_FILE" 2>&1 &
  DEV_PID=$!
  ok "App starting, pid ${DEV_PID}, log: ${LOG_FILE}"

  printf ' Waiting for http://127.0.0.1:%s/presence ' "$APP_PORT"
  started=0
  for _ in $(seq 1 45); do
    if app_alive; then started=1; break; fi
    # The process may have died on startup (port taken, build error) — waiting
    # for presence is then pointless, better to show the tail of the log.
    if ! kill -0 "$DEV_PID" 2>/dev/null; then break; fi
    printf '.'
    sleep 2
  done
  printf '\n'

  if [ "$started" = "1" ]; then
    ok 'The app is answering.'
  else
    err 'The app did not come up. Last lines of the log:'
    tail -n 25 "$LOG_FILE" 2>/dev/null | sed 's/^/     /'
    finish 1
  fi
fi

# ---- 6. verify MCP --------------------------------------------------------
step 'Checking MCP'
# 404/406 counts as alive too: the MCP endpoint answers a GET with a non-200,
# and that is normal.
node -e "
fetch('http://127.0.0.1:${MCP_PORT}/mcp',{signal:AbortSignal.timeout(2000)})
  .then(r=>console.log(r.ok||r.status===404||r.status===406
    ? '  MCP answers on :${MCP_PORT} (status '+r.status+')'
    : '  MCP status '+r.status))
  .catch(()=>console.log('  MCP is still coming up — the app retries with backoff.'))
" 2>/dev/null

node -e "
fetch('http://127.0.0.1:${APP_PORT}/presence',{signal:AbortSignal.timeout(1500)})
  .then(r=>r.json())
  .then(j=>console.log('  presence: pid '+j.pid+'  mcpRunning='+j.mcpRunning+'  dir='+(j.workspaceDir||'(no folder chosen)')))
  .catch(()=>console.log('  /presence did not answer — the app is still loading.'))
" 2>/dev/null

printf '\n %sDone.%s The app is running and MCP comes up automatically with it.\n' "$green" "$reset"
printf ' MCP clients (Claude Code, Codex, opencode, Cursor) configure themselves\n'
printf ' when you choose a working folder in the app.\n'
finish 0
