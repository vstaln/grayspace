import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const binary = process.platform === 'win32'
  ? 'native/target/release/grayspace.exe'
  : 'native/target/release/grayspace'

function newestInput(path) {
  if (!existsSync(path)) return 0
  const info = statSync(path)
  if (!info.isDirectory()) return info.mtimeMs

  let newest = 0
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    newest = Math.max(newest, newestInput(join(path, entry.name)))
  }
  return newest
}

const binaryMtime = existsSync(binary) ? statSync(binary).mtimeMs : 0
const buildInputs = [
  'native/Cargo.toml',
  'native/Cargo.lock',
  'native/orcspace-app/Cargo.toml',
  'native/orcspace-app/build.rs',
  'native/orcspace-app/src',
  // portable-pty is patched in from this vendored tree, so changes here also
  // change the engine even when the app's own Rust sources are untouched.
  'native/vendor/portable-pty'
]
const newestBuildInput = Math.max(...buildInputs.map(newestInput))
if (binaryMtime >= newestBuildInput) process.exit(0)

const result = spawnSync(
  process.execPath,
  ['scripts/native-cargo.mjs', 'build', '--release', '--bin', 'grayspace', '--manifest-path', 'native/orcspace-app/Cargo.toml'],
  { stdio: 'inherit', shell: false }
)
// The binary is optional at dev time: a missing Rust toolchain should not stop
// a contributor from editing the repo, but anything that launches the GUI
// needs it. A *packaged* build is different — a
// release that silently ships without the engine is a release nobody notices is
// degraded — so `prebuild` (and therefore every dist/installer script) is
// strict by default. ORCSPACE_NATIVE_STRICT=0/1 overrides either way.
function isStrict() {
  const explicit = process.env.ORCSPACE_NATIVE_STRICT
  if (explicit === '1') return true
  if (explicit === '0') return false
  return process.env.npm_lifecycle_event === 'prebuild'
}

if (result.error || (result.status ?? 1) !== 0) {
  const reason = result.error?.message ?? `exit code ${result.status ?? 1}`
  if (isStrict()) {
    console.error(`[native] engine build failed: ${reason}`)
    console.error('[native] set ORCSPACE_NATIVE_STRICT=0 to build without the native engine.')
    process.exit(result.status || 1)
  }
  console.warn(`[native] engine build skipped (${reason}); continuing without the GUI binary.`)
}
process.exit(0)
