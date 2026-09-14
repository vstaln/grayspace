import { crc32, deflateRawSync } from 'node:zlib'
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// Source archives are not a distribution channel: they are unsigned, so macOS
// Gatekeeper rejects them and the updater cannot verify them. Shipping one to
// users is the mistake this guard exists to prevent. It stays available behind
// an explicit opt-in for local reproduction of a packaging bug.
if (process.env.ORCSPACE_ALLOW_SOURCE_ARCHIVE !== '1') {
  console.error('Source installers are not for distribution: they are unsigned and the updater cannot verify them.')
  console.error('Ship signed binaries with npm run dist:mac or npm run installer:win.')
  console.error('For local debugging only, re-run with ORCSPACE_ALLOW_SOURCE_ARCHIVE=1.')
  process.exit(1)
}
const zipPath = join(root, 'OrcSpace-mac-source.zip')
const updateCmdPath = join(root, 'OrcSpace-Update.command')
const installerCmdPath = join(root, 'OrcSpace-Installer.command')

console.log('==> Gathering clean workspace files...')

const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'out',
  '.git',
  '.dev-user-data',
  'test-results',
  '.staging',
  'target'
])

const IGNORED_FILES = new Set([
  'OrcSpace-mac-source.zip',
  'OrcSpace-Update.command',
  'OrcSpace-Installer.command',
  '.DS_Store',
  'Thumbs.db'
])

function isIgnored(relPath) {
  const parts = relPath.split(/[\\/]/)
  for (const p of parts) {
    if (IGNORED_DIRS.has(p)) return true
  }
  const filename = parts[parts.length - 1]
  if (IGNORED_FILES.has(filename)) return true
  if (filename.endsWith('.log') || filename.endsWith('.tmp') || filename.endsWith('.node')) return true
  return false
}

function collectFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
  let files = []
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    const relPath = relative(root, fullPath)
    if (isIgnored(relPath)) continue

    if (entry.isDirectory()) {
      files = files.concat(collectFiles(fullPath))
    } else if (entry.isFile()) {
      files.push({ fullPath, relPath: relPath.replace(/\\/g, '/') })
    }
  }
  return files
}

const files = collectFiles(root)
console.log(`==> Found ${files.length} clean source files. Building zip...`)

function dosDateTime(date) {
  const d = new Date(date)
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date: dosDate }
}

const localHeaders = []
const centralHeaders = []
let offset = 0

for (const { fullPath, relPath } of files) {
  const rawData = readFileSync(fullPath)
  const stat = statSync(fullPath)
  const isExecutable = relPath.endsWith('.command') || relPath.endsWith('.sh') || relPath === 'cli/orc'
  const unixMode = isExecutable ? 0o755 : 0o644

  const compressedData = deflateRawSync(rawData, { level: 9 })
  const crc = crc32(rawData)
  const { time, date } = dosDateTime(stat.mtime)

  const entryName = `OrcSpace/${relPath}`
  const nameBuffer = Buffer.from(entryName, 'utf8')


  const localHeader = Buffer.alloc(30 + nameBuffer.length)
  localHeader.writeUInt32LE(0x04034b50, 0)
  localHeader.writeUInt16LE(20, 4)
  localHeader.writeUInt16LE(0x0800, 6)
  localHeader.writeUInt16LE(8, 8)
  localHeader.writeUInt16LE(time, 10)
  localHeader.writeUInt16LE(date, 12)
  localHeader.writeUInt32LE(crc, 14)
  localHeader.writeUInt32LE(compressedData.length, 18)
  localHeader.writeUInt32LE(rawData.length, 22)
  localHeader.writeUInt16LE(nameBuffer.length, 26)
  localHeader.writeUInt16LE(0, 28)
  nameBuffer.copy(localHeader, 30)

  localHeaders.push(localHeader, compressedData)


  const centralHeader = Buffer.alloc(46 + nameBuffer.length)
  centralHeader.writeUInt32LE(0x02014b50, 0)
  centralHeader.writeUInt16LE(0x0314, 4)
  centralHeader.writeUInt16LE(20, 6)
  centralHeader.writeUInt16LE(0x0800, 8)
  centralHeader.writeUInt16LE(8, 10)
  centralHeader.writeUInt16LE(time, 12)
  centralHeader.writeUInt16LE(date, 14)
  centralHeader.writeUInt32LE(crc, 16)
  centralHeader.writeUInt32LE(compressedData.length, 20)
  centralHeader.writeUInt32LE(rawData.length, 24)
  centralHeader.writeUInt16LE(nameBuffer.length, 28)
  centralHeader.writeUInt16LE(0, 30)
  centralHeader.writeUInt16LE(0, 32)
  centralHeader.writeUInt16LE(0, 34)
  centralHeader.writeUInt16LE(0, 36)
  centralHeader.writeUInt32LE(unixMode << 16, 38)
  centralHeader.writeUInt32LE(offset, 42)
  nameBuffer.copy(centralHeader, 46)

  centralHeaders.push(centralHeader)
  offset += localHeader.length + compressedData.length
}

const centralDirOffset = offset
let centralDirSize = 0
for (const h of centralHeaders) centralDirSize += h.length


const eocd = Buffer.alloc(22)
eocd.writeUInt32LE(0x06054b50, 0)
eocd.writeUInt16LE(0, 4)
eocd.writeUInt16LE(0, 6)
eocd.writeUInt16LE(files.length, 8)
eocd.writeUInt16LE(files.length, 10)
eocd.writeUInt32LE(centralDirSize, 12)
eocd.writeUInt32LE(centralDirOffset, 16)
eocd.writeUInt16LE(0, 20)

const finalZipBuffer = Buffer.concat([...localHeaders, ...centralHeaders, eocd])
writeFileSync(zipPath, finalZipBuffer)
console.log(` [ok] Created ${zipPath} (${(finalZipBuffer.length / 1024 / 1024).toFixed(2)} MB)`)

console.log('==> Creating OrcSpace standalone Mac installer scripts...')
const base64Payload = finalZipBuffer.toString('base64')

const installerScriptHeader = `#!/bin/bash
# ==============================================================================
#  OrcSpace — Standalone 1-File Installer for macOS
#  Unpacks, installs dependencies, clears Gatekeeper quarantine, and runs.
# ==============================================================================
set -u -o pipefail

bold=$'\\033[1m'; dim=$'\\033[2m'; red=$'\\033[31m'; green=$'\\033[32m'; yellow=$'\\033[33m'; cyan=$'\\033[36m'; reset=$'\\033[0m'
ok()   { printf ' %s[ok]%s %s\\n' "$green"  "$reset" "$1"; }
warn() { printf ' %s[!]%s  %s\\n' "$yellow" "$reset" "$1"; }
err()  { printf ' %s[x]%s  %s\\n' "$red"    "$reset" "$1"; }
step() { printf '\\n%s==>%s %s\\n' "$bold"   "$reset" "$1"; }

KEEP_OPEN=0
case "\${TERM_PROGRAM:-}" in
  Apple_Terminal|iTerm.app) [ -t 0 ] && KEEP_OPEN=1 ;;
esac
finish() {
  if [ "$KEEP_OPEN" = "1" ]; then
    printf '\\n%sPress Enter to close this window.%s ' "$dim" "$reset"
    read -r _ || true
  fi
  exit "$1"
}
die() { err "$1"; finish 1; }

export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:$HOME/.volta/bin:$HOME/.fnm/current/bin:$PATH"

printf '\\n %sOrcSpace — macOS 1-Click Installer%s\\n' "$bold" "$reset"
printf ' %s\\n' "──────────────────────────────────────────────────────────"

SCRIPT_PATH="$0"
PAYLOAD_LINE=$(grep -an '^__PAYLOAD_BELOW__$' "$SCRIPT_PATH" | head -1 | cut -d: -f1)
if [ -z "$PAYLOAD_LINE" ]; then
  die "This installer file is corrupted (no payload marker found)."
fi

step '1/4 Checking environment'
if ! command -v node >/dev/null 2>&1; then
  warn 'Node.js is not installed.'
  if command -v brew >/dev/null 2>&1; then
    printf ' Installing Node.js via Homebrew...\\n'
    brew install node || die 'Failed to install Node.js via Homebrew.'
  else
    err 'Please install Node.js (LTS version) from https://nodejs.org'
    die 'After installing Node.js, run this installer again.'
  fi
fi
ok "Node.js $(node -v) detected."

if ! xcode-select -p >/dev/null 2>&1; then
  warn 'Xcode Command Line Tools missing. Triggering system installer...'
  xcode-select --install 2>/dev/null || true
fi

step '2/4 Extracting OrcSpace'
DEST="$HOME/Desktop/OrcSpace"
TMPZIP="$(mktemp -t orcspace-pkg).zip"

if ! tail -n +"$((PAYLOAD_LINE + 1))" "$SCRIPT_PATH" | base64 -d > "$TMPZIP" 2>/dev/null; then
  tail -n +"$((PAYLOAD_LINE + 1))" "$SCRIPT_PATH" | base64 -D > "$TMPZIP" 2>/dev/null || die 'Failed to extract payload.'
fi

if [ -d "$DEST" ]; then
  BACKUP="$HOME/Desktop/OrcSpace-backup-$(date +%Y%m%d-%H%M%S)"
  printf ' Backing up existing OrcSpace folder to %s...\\n' "$(basename "$BACKUP")"
  mv "$DEST" "$BACKUP"
fi

unzip -q "$TMPZIP" -d "$HOME/Desktop" || die 'Failed to unzip OrcSpace.'
rm -f "$TMPZIP"
cd "$DEST" || die "Could not enter $DEST"
ok "Unpacked to $DEST"

step '3/4 Configuring & Removing Gatekeeper Quarantine'
xattr -cr "$DEST" 2>/dev/null || true
chmod +x "$DEST"/*.command "$DEST"/cli/orc 2>/dev/null || true
ok 'Permissions and quarantine cleared.'

step '4/4 Installing Dependencies'
if [ -f package-lock.json ]; then
  npm ci --no-fund --no-audit || npm install --no-fund --no-audit || die 'npm install failed.'
else
  npm install --no-fund --no-audit || die 'npm install failed.'
fi
ok 'Dependencies ready.'

printf '\\n%sOrcSpace is ready!%s\\n' "$green" "$reset"
printf ' Location: %s%s%s\\n' "$cyan" "$DEST" "$reset"
printf ' [1] Starting OrcSpace now...\\n\\n'

npm run dev
finish 0
__PAYLOAD_BELOW__
`

const chunkedBase64 = base64Payload.match(/.{1,76}/g)?.join('\n') || base64Payload
writeFileSync(installerCmdPath, installerScriptHeader + chunkedBase64 + '\n', 'utf8')
writeFileSync(updateCmdPath, installerScriptHeader + chunkedBase64 + '\n', 'utf8')

console.log(` [ok] Created ${installerCmdPath} (${(statSync(installerCmdPath).size / 1024 / 1024).toFixed(2)} MB)`)
console.log(` [ok] Created ${updateCmdPath} (${(statSync(updateCmdPath).size / 1024 / 1024).toFixed(2)} MB)`)
