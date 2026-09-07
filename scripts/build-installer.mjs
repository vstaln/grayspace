#!/usr/bin/env node
/**
 * Reproducible Windows installer entry point.
 *
 * Keeps the release path in one place so a developer cannot accidentally ship
 * an installer made from stale renderer output or a broken native addon.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const skipTests = process.argv.includes('--skip-tests')
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)

function run(command, args) {
  console.log(`\n==> ${command} ${args.join(' ')}`)
  // Windows exposes npm as a .cmd shim; shell mode is required for that shim
  // to behave consistently when launched from Node.
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed${result.status == null ? '' : ` with exit code ${result.status}`}`)
  }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

try {
  if (process.platform !== 'win32') {
    throw new Error('The Windows installer must be built on Windows (electron-builder cannot cross-build NSIS reliably).')
  }
  if (nodeMajor < 20 || nodeMajor >= 25) {
    throw new Error(`Node.js 20–24 is required for the native dependencies (detected ${process.versions.node}).`)
  }
  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!packageJson.version || !packageJson.name) throw new Error('package.json has no valid name/version.')
  if (!existsSync(join(root, 'package-lock.json'))) throw new Error('package-lock.json is required for a reproducible build.')

  run(npm, ['ci', '--no-fund', '--no-audit'])
  run(npm, ['run', 'typecheck'])
  if (!skipTests) run(npm, ['test'])
  run(npm, ['run', 'dist'])

  const installer = join(dist, `OrcSpace-Setup-${packageJson.version}-x64.exe`)
  const portable = join(dist, `OrcSpace-${packageJson.version}-x64-Portable.exe`)
  for (const artifact of [installer, portable]) {
    if (!existsSync(artifact) || statSync(artifact).size < 10 * 1024 * 1024) {
      throw new Error(`Expected release artifact is missing or suspiciously small: ${artifact}`)
    }
  }

  const manifest = {
    product: 'OrcSpace',
    version: packageJson.version,
    platform: 'win32',
    arch: 'x64',
    installer: { file: installer.split(/[/\\]/).pop(), sha256: sha256(installer), bytes: statSync(installer).size },
    portable: { file: portable.split(/[/\\]/).pop(), sha256: sha256(portable), bytes: statSync(portable).size },
    generatedAt: new Date().toISOString(),
  }
  mkdirSync(dist, { recursive: true })
  writeFileSync(join(dist, 'checksums.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(`\n[ok] Stable Windows installer created: ${installer}`)
  console.log(`[ok] SHA-256 manifest: ${join(dist, 'checksums.json')}`)
} catch (error) {
  console.error(`\n[x] Installer build failed: ${error.message}`)
  process.exitCode = 1
}
