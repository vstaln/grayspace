import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchWindowsPtyAgents } from '../scripts/patch-pty.mjs'

const CRATES = ['canvas-core', 'storage-core']
const ELECTRON_VERSION = '43.3.0'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Rebuild the PTY native addon for Electron's ABI.
 * On Windows it compiles conpty.node; on macOS/Linux it compiles pty.node.
 * This guarantees terminal widgets work in Electron regardless of npmRebuild: false.
 *
 * The Windows agent patch runs FIRST, before any early return: node_modules
 * survives across builds, so a repeat build finds conpty.node already built
 * and returns early — gating the patch behind that return left upgraded
 * installs unpatched (and the 5s kill hang in place) forever.
 */
function ensureElectronPty() {
  try {
    const packageDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')
    patchWindowsPtyAgents(packageDir)
    const addonName = process.platform === 'win32' ? 'conpty.node' : 'pty.node'
    const addon = join(packageDir, 'build', 'Release', addonName)
    if (existsSync(addon)) return

    // A previous Windows distribution contains the Electron-compatible addon.
    // Reuse it when the machine has no Visual Studio C++ workload; otherwise a
    // fresh checkout cannot start terminals even though the app was packaged.
    if (process.platform === 'win32') {
      const bundledRelease = join(
        repoRoot,
        'dist',
        'win-unpacked',
        'resources',
        'app.asar.unpacked',
        'node_modules',
        '@homebridge',
        'node-pty-prebuilt-multiarch',
        'build',
        'Release'
      )
      const bundledAddon = join(bundledRelease, addonName)
      if (existsSync(bundledAddon)) {
        mkdirSync(dirname(addon), { recursive: true })
        for (const file of ['conpty.node', 'conpty_console_list.node', 'winpty-agent.exe', 'winpty.dll']) {
          const source = join(bundledRelease, file)
          if (existsSync(source)) copyFileSync(source, join(dirname(addon), file))
        }
        console.log(`[pty] Restored ${addonName} from the existing Windows distribution.`)
        patchWindowsPtyAgents(packageDir)
        return
      }
    }

    const nodeGyp = join(
      repoRoot,
      'node_modules',
      '.bin',
      process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp'
    )
    if (!existsSync(nodeGyp) || !existsSync(join(packageDir, 'binding.gyp'))) {
      console.warn(`[pty] Terminal addon source missing; using fallback.`)
      return
    }

    console.log(`[pty] Building ${addonName} for Electron ${ELECTRON_VERSION} (${process.platform})...`)
    const result = spawnSync(
      nodeGyp,
      ['rebuild', '--runtime=electron', `--target=${ELECTRON_VERSION}`, '--dist-url=https://electronjs.org/headers'],
      { cwd: packageDir, stdio: 'inherit', shell: true }
    )
    if (result.status !== 0 || !existsSync(addon)) {
      console.warn(`[pty] Non-fatal: Failed to build ${addonName}; using standard fallback.`)
    }
    // A fresh compile drops pristine agent sources — re-apply the patch.
    patchWindowsPtyAgents(packageDir)
  } catch (err) {
    console.warn(`[pty] ensureElectronPty warning:`, err.message)
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
  const hasNode = existsSync(crateDir) && readdirSync(crateDir).some((f) => f.endsWith('.node'))
  if (hasNode && existsSync(join(crateDir, 'loader.cjs')) && !process.env.FORCE_NATIVE_REBUILD) {
    continue
  }
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
    console.warn(`[native] ${crate} loader missing — falling back to TS`)
    failed.push(crate)
    continue
  }
}

if (failed.length > 0) {
  console.warn(
    `[native] ${failed.length}/${CRATES.length} crate(s) fell back to TypeScript: ${failed.join(', ')}. ` +
      'The app still works, but the accelerated paths are off.'
  )
}
