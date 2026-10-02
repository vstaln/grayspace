#!/usr/bin/env node

/**
 * Builds the production Linux installer (AppImage and/or .deb) for OrcSpace.
 *
 * Usage:
 *   node scripts/build-installer-linux.mjs [--skip-ci] [--dirty] [--skip-tests] [--appimage] [--deb] [--tar] [--all]
 */

import { createHash } from 'node:crypto'
import { accessSync, chmodSync, constants, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { isSupportedNodeVersion, SUPPORTED_NODE_VERSION_TEXT } from './node-support.mjs'
import { prepareLinuxPackage } from './prepare-linux-package.mjs'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const outputDir = join(dist, 'installers', 'linux')
const skipTests = process.argv.includes('--skip-tests')
const skipCi = process.argv.includes('--skip-ci')
const dirtyBuild = process.argv.includes('--dirty')
const packagedE2e = process.argv.includes('--packaged-e2e')
let originalCliMode

function run(command, args, env = process.env) {
  console.log(`\n==> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    windowsHide: true,
    env,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed${result.status == null ? '' : ` with exit code ${result.status}`}`)
  }
}

function runNpm(args) {
  const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return run(npmCmd, args)
}

function runLocalBin(name, args) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  const command = join(root, 'node_modules', '.bin', `${name}${suffix}`)
  if (!existsSync(command)) throw new Error(`Missing local build tool: ${command}`)
  return run(command, args)
}

function prepareElectronSandbox() {
  const sandbox = join(outputDir, 'linux-unpacked', 'chrome-sandbox')
  if (!existsSync(sandbox)) throw new Error(`Packaged chrome-sandbox is missing: ${sandbox}`)
  run('sudo', ['chown', 'root:root', sandbox])
  run('sudo', ['chmod', '4755', sandbox])
}

function runPackagedE2e(executable) {
  const playwright = join(root, 'node_modules', '.bin', 'playwright')
  const args = ['test', 'e2e/specs/packaged-terminal-interrupt.spec.ts', '--project=ci']
  run('xvfb-run', ['-a', playwright, ...args], { ...process.env, ORCSPACE_PACKAGED: executable })
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function verifyUnpackedRelease(packageJson) {
  if (!packageJson.version) throw new Error('Release package has no version.')
  const unpacked = join(outputDir, 'linux-unpacked')
  if (!existsSync(unpacked)) throw new Error('Packaged Linux runtime directory is missing.')
  const resources = join(unpacked, 'resources')
  const requiredFiles = [
    join(unpacked, 'orcspace'),
    join(resources, 'app.asar'),
    join(resources, 'cli', 'orc.mjs'),
    join(resources, 'cli', 'orc'),
    join(resources, 'native', 'orcspace-engine'),
    join(resources, 'native', 'canvas-core', 'loader.cjs'),
    join(resources, 'native', 'canvas-core', 'index.linux-x64-gnu.node'),
    join(resources, 'native', 'storage-core', 'loader.cjs'),
    join(resources, 'native', 'storage-core', 'index.linux-x64-gnu.node')
  ]
  const missing = requiredFiles.filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`Unpacked Linux release is incomplete:\n${missing.join('\n')}`)
  try {
    accessSync(join(resources, 'cli', 'orc'), constants.X_OK)
    accessSync(join(resources, 'native', 'orcspace-engine'), constants.X_OK)
  } catch {
    throw new Error('Packaged Linux CLI or native engine is not executable.')
  }

  const asar = readFileSync(join(resources, 'app.asar'))
  for (const marker of ['music-player', 'youtube.com/iframe_api', 'Orchestration', 'AI Chat']) {
    if (!asar.includes(marker)) throw new Error(`Renderer bundle is missing required feature marker: ${marker}`)
  }

  if (process.platform === 'linux') {
    const cliScript = join(resources, 'cli', 'orc')
    const help = spawnSync('sh', [cliScript, '--help'], {
      cwd: join(resources, 'cli'),
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, ORCSPACE_NODE: process.execPath, ORCSPACE_URL: '', ORCSPACE_SOCKET_PATH: '', ORCSPACE_TOKEN: '' }
    })
    if (help.error || help.status !== 0 || !String(help.stdout || '').includes('orc — OrcSpace agent CLI')) {
      throw new Error(`Packaged orc CLI health check failed${help.error ? `: ${help.error.message}` : ''}`)
    }
  }

}

/**
 * electron-updater on Linux reads latest-linux.yml: it lists the AppImage and
 * the .deb (the tar.gz is not updatable). Without it, installed copies see no
 * release at all, so a build that lacks it must not be shipped.
 */
function verifyUpdateFeed(packageJson, targets, expectedArtifacts) {
  const feed = join(outputDir, 'latest-linux.yml')
  if (!existsSync(feed)) throw new Error('latest-linux.yml was not generated; auto-update would not see this release.')
  const text = readFileSync(feed, 'utf8')
  if (!text.split(/\r?\n/).includes(`version: ${packageJson.version}`)) {
    throw new Error(`latest-linux.yml does not describe version ${packageJson.version}.`)
  }
  targets.forEach((target, index) => {
    if (target === 'tar.gz') return
    const name = expectedArtifacts[index].split(/[\\/]/).pop()
    if (!text.includes(`url: ${name}`)) throw new Error(`latest-linux.yml does not list ${name}.`)
  })
}

try {
  if (process.platform !== 'linux') {
    throw new Error('Linux installers must be built on Linux; on Windows use build-linux-docker.bat or the GitHub Actions release workflow.')
  }
  if (process.arch !== 'x64') throw new Error(`This Linux installer targets x64; use x64 Node.js (detected ${process.arch}).`)
  const xvfb = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  if (xvfb.error || xvfb.status !== 0) throw new Error('xvfb-run is required for the packaged Linux startup check; install xvfb.')
  originalCliMode = prepareLinuxPackage(root)

  if (!isSupportedNodeVersion()) {
    throw new Error(`Node.js ${SUPPORTED_NODE_VERSION_TEXT} is required for the build (detected ${process.versions.node}).`)
  }

  const packageJson = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (!packageJson.version || !packageJson.name) throw new Error('package.json has no valid name/version.')
  if (!existsSync(join(root, 'package-lock.json'))) throw new Error('package-lock.json is required for a reproducible build.')

  if (!skipCi) {
    runNpm(['ci', '--no-fund', '--no-audit'])
  } else if (!dirtyBuild && process.env.CI !== 'true') {
    throw new Error('--skip-ci is only allowed for CI builds or with the explicit --dirty flag.')
  }

  runNpm(['run', 'typecheck'])

  if (!skipTests) {
    run(process.execPath, ['scripts/ensure-native-engine.mjs'], {
      ...process.env,
      ORCSPACE_NATIVE_STRICT: '1'
    })
    runNpm(['test'])
  } else {
    run(process.execPath, ['--test', 'scripts/release-security.test.cjs'])
  }

  // Build desktop assets (native addons + electron-vite)
  runNpm(['run', 'build:electron'])

  mkdirSync(dist, { recursive: true })
  mkdirSync(outputDir, { recursive: true })
  rmSync(join(outputDir, 'linux-unpacked'), { recursive: true, force: true })
  rmSync(join(outputDir, 'builder-debug.yml'), { force: true })
  rmSync(join(outputDir, 'builder-effective-config.yaml'), { force: true })
  rmSync(join(outputDir, 'checksums-linux.json'), { force: true })
  // A stale feed from an earlier build would describe files that no longer exist.
  rmSync(join(outputDir, 'latest-linux.yml'), { force: true })

  // Determine target formats
  const targets = []
  if (process.argv.includes('--appimage')) {
    targets.push('AppImage')
  } else if (process.argv.includes('--deb')) {
    targets.push('deb')
  } else if (process.argv.includes('--tar')) {
    targets.push('tar.gz')
  } else if (process.argv.includes('--all')) {
    targets.push('AppImage', 'deb', 'tar.gz')
  } else {
    targets.push('AppImage', 'deb', 'tar.gz')
  }

  const productName = packageJson.build?.productName || packageJson.name
  const extensions = { AppImage: '.AppImage', deb: '.deb', 'tar.gz': '.tar.gz' }
  const architectureLabels = { AppImage: 'x86_64', deb: 'amd64', 'tar.gz': 'x64' }
  const expectedArtifacts = targets.map((target) => join(outputDir, `${productName}-${packageJson.version}-${architectureLabels[target]}${extensions[target]}`))
  for (const artifact of expectedArtifacts) rmSync(artifact, { force: true })

  console.log(`\n==> Packaging Linux targets: ${targets.join(', ')}`)
  runLocalBin('electron-builder', [
    '--linux', ...targets, '--x64', '--publish', 'never',
    `--config.directories.output=${outputDir}`
  ])

  verifyUnpackedRelease(packageJson)
  prepareElectronSandbox()

  // Find generated installer files
  const artifacts = []
  for (const fullPath of expectedArtifacts) {
    if (!existsSync(fullPath)) throw new Error(`Expected Linux release artifact is missing: ${fullPath}`)
    const st = statSync(fullPath)
    if (!st.isFile() || st.size < 10 * 1024 * 1024) throw new Error(`Linux release artifact is incomplete or suspiciously small: ${fullPath}`)
    artifacts.push({
      file: fullPath.split(/[\\/]/).pop(),
      sizeBytes: st.size,
      sizeMB: (st.size / (1024 * 1024)).toFixed(2) + ' MB',
      sha256: sha256(fullPath)
    })
  }
  verifyUpdateFeed(packageJson, targets, expectedArtifacts)
  run(process.execPath, ['scripts/smoke-packaged-linux.cjs', join(outputDir, 'linux-unpacked')])
  if (packagedE2e) runPackagedE2e(join(outputDir, 'linux-unpacked', 'orcspace'))
  rmSync(join(outputDir, 'linux-unpacked'), { recursive: true, force: true })

  const manifest = {
    product: 'OrcSpace',
    version: packageJson.version,
    platform: 'linux',
    arch: 'x64',
    dirty: dirtyBuild,
    targets,
    packageLockSha256: sha256(join(root, 'package-lock.json')),
    artifacts,
    generatedAt: new Date().toISOString()
  }
  writeFileSync(join(outputDir, 'checksums-linux.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Cleanup build artifacts
  rmSync(join(outputDir, 'builder-debug.yml'), { force: true })
  rmSync(join(outputDir, 'builder-effective-config.yaml'), { force: true })

  console.log('\n==========================================================')
  console.log(' [ok] Linux installer build finished successfully!')
  console.log('==========================================================')
  for (const art of artifacts) {
    console.log(`  • ${art.file} (${art.sizeMB})`)
    console.log(`    SHA-256: ${art.sha256}`)
  }
  console.log(`\n[ok] Manifest written to: ${join(outputDir, 'checksums-linux.json')}\n`)
} catch (error) {
  console.error(`\n[x] Linux installer build failed: ${error.message}`)
  process.exitCode = 1
} finally {
  if (originalCliMode !== undefined) {
    try {
      chmodSync(join(root, 'cli', 'orc'), originalCliMode)
    } catch (error) {
      console.error(`[x] Could not restore cli/orc file permissions: ${error.message}`)
      process.exitCode = 1
    }
  }
}
