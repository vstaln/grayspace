import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CRATES = ['canvas-core', 'brain-core', 'storage-core']
const ELECTRON_VERSION = '43.3.0'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Rebuild the PTY native addon for Electron's ABI.
 * On Windows it compiles conpty.node; on macOS/Linux it compiles pty.node.
 * This guarantees terminal widgets work in Electron regardless of npmRebuild: false.
 */
function ensureElectronPty() {
  const packageDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')
  const addonName = process.platform === 'win32' ? 'conpty.node' : 'pty.node'
  const addon = join(packageDir, 'build', 'Release', addonName)
  if (existsSync(addon)) return

  const nodeGyp = join(
    repoRoot,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp'
  )
  if (!existsSync(nodeGyp) || !existsSync(join(packageDir, 'binding.gyp'))) {
    throw new Error(`[pty] Terminal addon is missing; install dependencies before building.`)
  }

  console.log(`[pty] Building ${addonName} for Electron ${ELECTRON_VERSION} (${process.platform})...`)
  const result = spawnSync(
    nodeGyp,
    ['rebuild', '--runtime=electron', `--target=${ELECTRON_VERSION}`, '--dist-url=https://electronjs.org/headers'],
    { cwd: packageDir, stdio: 'inherit', shell: true }
  )
  if (result.status !== 0 || !existsSync(addon)) {
    throw new Error(`[pty] Failed to build ${addonName}; terminal widgets cannot start without it.`)
  }
}

ensureElectronPty()

const command = process.platform === 'win32' ? 'where.exe' : 'sh'
const args = process.platform === 'win32' ? ['cargo'] : ['-c', 'command -v cargo']
const cargoCheck = spawnSync(command, args, { stdio: 'ignore' })

if (cargoCheck.status !== 0) {
  console.warn('[native] Rust toolchain not found; using the TypeScript fallbacks for every native crate.')
  process.exit(0)
}

/**
 * Resolve `@napi-rs/cli` out of the repo's own node_modules instead of trusting
 * PATH. `npm run build:native` happens to put `node_modules/.bin` on PATH, but
 * every other way of reaching this script — `node native/build.mjs`, a wrapper
 * shell, CI calling it directly — does not, and the crate loop below treats a
 * missing binary as "no Rust available" and silently ships the TypeScript
 * fallbacks. The app then runs its slow paths with nothing but a warning that
 * scrolls past in the build log.
 */
const localBin = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'napi.cmd' : 'napi'
)
const napi = existsSync(localBin) ? localBin : process.platform === 'win32' ? 'napi.cmd' : 'napi'

// Each crate degrades independently: one failing to build must not stop the
// others, and must never fail `npm run build:native` — every native crate
// here backs an optional acceleration path with a TypeScript fallback.
const failed = []
for (const crate of CRATES) {
  const crateDir = join(repoRoot, 'native', crate)
  const result = spawnSync(napi, ['build', '--platform', '--release'], {
    cwd: crateDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error || result.status !== 0) {
    console.warn(`[native] napi-rs build unavailable for ${crate}; using the TypeScript fallback.`)
    failed.push(crate)
    continue
  }

  if (!existsSync(join(crateDir, 'loader.cjs'))) {
    throw new Error(`[native] ${crate} loader is missing`)
  }
}

if (failed.length > 0) {
  console.warn(
    `[native] ${failed.length}/${CRATES.length} crate(s) fell back to TypeScript: ${failed.join(', ')}. ` +
      'The app still works, but the accelerated paths are off.'
  )
}
