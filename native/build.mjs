import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { patchWindowsPtyAgents } from '../scripts/patch-pty.mjs'
import { ensureConptyRuntime } from '../scripts/conpty-runtime.mjs'

// The N-API addons, built one at a time by `napi build` below. They are
// deliberately absent from native/Cargo.toml's `members` and listed in its
// `exclude` — see the comment there. This list is therefore not a workspace
// member list and is not expected to match one; the workspace builds a single
// member, orcspace-app, through scripts/native-cargo.mjs instead.
//
// Every crate here degrades to a JavaScript fallback when its build fails, so
// a missing Rust toolchain costs speed, never function (src/main/storage.ts
// and src/main/ansi.ts catch the load error).
const CRATES = ['canvas-core', 'storage-core']
const ELECTRON_VERSION = '43.3.0'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')











function ensureElectronPty() {
  const packageDir = join(repoRoot, 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch')
  const bundledRelease = join(repoRoot, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked',
    'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release')
  // Both PTY backends require the DLL and its matching host, even when the
  // native addon already exists. Do not downgrade this failure to a warning.
  if (process.platform === 'win32') ensureConptyRuntime(packageDir, bundledRelease)
  try {
    patchWindowsPtyAgents(packageDir)
    const addonName = process.platform === 'win32' ? 'conpty.node' : 'pty.node'
    const addon = join(packageDir, 'build', 'Release', addonName)
    if (existsSync(addon)) return




    if (process.platform === 'win32') {
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

    patchWindowsPtyAgents(packageDir)
  } catch (err) {
    console.warn(`[pty] ensureElectronPty warning:`, err.message)
  } finally {
    // node-gyp rebuild can remove build/Release, including the runtime pair.
    if (process.platform === 'win32') ensureConptyRuntime(packageDir, bundledRelease)
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










const localBin = join(
  repoRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'napi.cmd' : 'napi'
)
const napi = existsSync(localBin) ? localBin : process.platform === 'win32' ? 'napi.cmd' : 'napi'




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
