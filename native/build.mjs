import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const CRATES = ['canvas-core', 'brain-core', 'storage-core']

const command = process.platform === 'win32' ? 'where.exe' : 'sh'
const args = process.platform === 'win32' ? ['cargo'] : ['-c', 'command -v cargo']
const cargoCheck = spawnSync(command, args, { stdio: 'ignore' })

if (cargoCheck.status !== 0) {
  console.warn('[native] Rust toolchain not found; using the TypeScript fallbacks for every native crate.')
  process.exit(0)
}

const napi = process.platform === 'win32' ? 'napi.cmd' : 'napi'

// Each crate degrades independently: one failing to build must not stop the
// others, and must never fail `npm run build:native` — every native crate
// here backs an optional acceleration path with a TypeScript fallback.
for (const crate of CRATES) {
  const crateDir = join(process.cwd(), 'native', crate)
  const result = spawnSync(napi, ['build', '--platform', '--release'], {
    cwd: crateDir,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error || result.status !== 0) {
    console.warn(`[native] napi-rs build unavailable for ${crate}; using the TypeScript fallback.`)
    continue
  }

  if (!existsSync(join(crateDir, 'loader.cjs'))) {
    throw new Error(`[native] ${crate} loader is missing`)
  }
}
