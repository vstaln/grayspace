#!/usr/bin/env node






import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dist = join(root, 'dist')
const skipTests = process.argv.includes('--skip-tests')
const skipCi = process.argv.includes('--skip-ci')
const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10)







function npmInvocation(args) {
  const runtimeDir = dirname(process.execPath)
  const delimiter = process.platform === 'win32' ? ';' : ':'
  const env = { ...process.env, PATH: `${runtimeDir}${delimiter}${process.env.PATH || ''}` }
  if (process.platform !== 'win32') return { command: 'npm', args, env }

  const located = spawnSync('where.exe', ['npm.cmd'], { encoding: 'utf8', windowsHide: true })
  const npmCmd = String(located.stdout || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  if (npmCmd && existsSync(npmCmd)) {
    try {
      const shim = readFileSync(npmCmd, 'utf8')
      const match = /NPM_CLI_JS=([^\r\n"]+)/i.exec(shim)
      if (match) {
        const cli = match[1].trim().replace(/^%~dp0/i, `${dirname(npmCmd)}\\`)
        if (existsSync(cli)) return { command: process.execPath, args: [cli, ...args], env }
      }
    } catch {

    }
  }
  return { command: 'npm.cmd', args, env }
}

function run(command, args, env = process.env) {
  console.log(`\n==> ${command} ${args.join(' ')}`)


  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',


    shell: process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command),
    env,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed${result.status == null ? '' : ` with exit code ${result.status}`}`)
  }
}

function runNpm(args) {
  const invocation = npmInvocation(args)
  return run(invocation.command, invocation.args, invocation.env)
}

function runLocalBin(name, args) {
  const suffix = process.platform === 'win32' ? '.cmd' : ''
  const command = join(root, 'node_modules', '.bin', `${name}${suffix}`)
  if (!existsSync(command)) throw new Error(`Missing local build tool: ${command}`)
  return run(command, args)
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}







function verifyUnpackedRelease(packageJson) {
  const unpacked = join(dist, 'win-unpacked')
  const resources = join(unpacked, 'resources')
  const requiredFiles = [
    join(unpacked, 'OrcSpace.exe'),
    join(resources, 'app.asar'),
    join(resources, 'cli', 'orc.mjs'),
    join(resources, 'cli', 'orc.cmd'),
    join(resources, 'cli', 'orc.bat'),
    join(resources, 'native', 'canvas-core', 'loader.cjs'),
    join(resources, 'native', 'storage-core', 'loader.cjs'),
    join(resources, 'native', 'orcspace-engine.exe'),
    join(resources, 'app.asar.unpacked', 'node_modules', '@homebridge', 'node-pty-prebuilt-multiarch', 'build', 'Release', 'conpty.node')
  ]
  const missing = requiredFiles.filter((file) => !existsSync(file))
  if (missing.length) throw new Error(`Unpacked release is incomplete:\n${missing.join('\n')}`)

  const asar = readFileSync(join(resources, 'app.asar'))


  for (const marker of ['music-player', 'youtube.com/iframe_api', 'Orchestration']) {
    if (!asar.includes(marker)) throw new Error(`Renderer bundle is missing required feature marker: ${marker}`)
  }

  const cliShim = join(resources, 'cli', 'orc.cmd')




  const help = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'call orc.cmd --help'], {
    cwd: join(resources, 'cli'),
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15_000,
    shell: false,
    env: { ...process.env, ORCSPACE_NODE: process.execPath, ORCSPACE_URL: '', ORCSPACE_SOCKET_PATH: '', ORCSPACE_TOKEN: '' }
  })
  if (help.error || help.status !== 0 || !String(help.stdout || '').includes('orc — OrcSpace agent CLI')) {
    throw new Error(`Packaged orc CLI health check failed${help.error ? `: ${help.error.message}` : ''}`)
  }
  if (!packageJson.version) throw new Error('Release package has no version.')
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
  const installer = join(dist, `OrcSpace-Setup-${packageJson.version}-x64.exe`)
  const legacyPortable = join(dist, `OrcSpace-${packageJson.version}-x64-Portable.exe`)

  if (!skipCi) {
    runNpm(['ci', '--no-fund', '--no-audit'])
  } else if (!process.argv.includes('--dirty')) {
    throw new Error('--skip-ci requires --dirty: building on unpinned node_modules is not reproducible.')
  }
  runNpm(['run', 'typecheck'])
  if (!skipTests) runNpm(['test'])
  // Build once, then package only the NSIS installer. The old `dist` script
  // produced both NSIS and portable artifacts, which doubled the work and
  // could leave a stale installer in `dist` after a partial build.
  runNpm(['run', 'build'])
  rmSync(join(dist, 'win-unpacked'), { recursive: true, force: true })
  rmSync(installer, { force: true })
  rmSync(legacyPortable, { force: true })
  runLocalBin('electron-builder', ['--win', 'nsis', '--x64', '--publish', 'never'])

  verifyUnpackedRelease(packageJson)

  if (!existsSync(installer) || statSync(installer).size < 10 * 1024 * 1024) {
    throw new Error(`Expected release artifact is missing or suspiciously small: ${installer}`)
  }

  const dirty = skipCi || process.argv.includes('--dirty')
  const manifest = {
    product: 'OrcSpace',
    version: packageJson.version,
    platform: 'win32',
    arch: 'x64',
    dirty,
    packageLockSha256: sha256(join(root, 'package-lock.json')),
    installer: { file: installer.split(/[/\\]/).pop(), sha256: sha256(installer), bytes: statSync(installer).size },
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
