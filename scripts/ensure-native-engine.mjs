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
if (result.error) {
  console.error(`[native] engine build failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
