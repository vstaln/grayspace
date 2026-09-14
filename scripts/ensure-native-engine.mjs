import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const binary = process.platform === 'win32'
  ? 'native/target/release/orcspace.exe'
  : 'native/target/release/orcspace'

function newestSource(dir) {
  let newest = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestSource(path))
    else newest = Math.max(newest, statSync(path).mtimeMs)
  }
  return newest
}

const binaryMtime = existsSync(binary) ? statSync(binary).mtimeMs : 0
if (binaryMtime >= newestSource('native/orcspace-app/src')) process.exit(0)

const result = spawnSync(
  process.execPath,
  ['scripts/native-cargo.mjs', 'build', '--release', '--bin', 'orcspace', '--manifest-path', 'native/orcspace-app/Cargo.toml'],
  { stdio: 'inherit', shell: false }
)
// The Rust engine is optional at dev time: the Electron app falls back to Node
// PTY (see native/README.md), and a missing Rust toolchain should not stop a
// contributor from running `npm run dev`. A *packaged* build is different — a
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
  console.warn(`[native] engine build skipped (${reason}); continuing with Node PTY fallback.`)
}
process.exit(0)
