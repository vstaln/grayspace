import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const files = ['conpty.dll', 'OpenConsole.exe']

export function verifyConptyRuntime(directory) {
  const missing = files.filter(file => !existsSync(join(directory, file)))
  if (missing.length) throw new Error(`ConPTY runtime is incomplete: ${missing.map(file => join(directory, file)).join(', ')}`)
}

export function ensureConptyRuntime(packageDir, bundledRelease, arch = process.arch) {
  const destination = join(packageDir, 'build', 'Release', 'conpty')
  if (files.every(file => existsSync(join(destination, file)))) return
  const thirdParty = join(packageDir, 'third_party', 'conpty')
  const candidates = existsSync(thirdParty)
    ? readdirSync(thirdParty).sort().reverse().map(version => join(thirdParty, version, `win10-${arch}`))
    : []
  if (bundledRelease) candidates.push(join(bundledRelease, 'conpty'))
  const source = candidates.find(directory => files.every(file => existsSync(join(directory, file))))
  if (!source) throw new Error(`No complete ConPTY runtime for ${arch}; reinstall node-pty dependencies`)
  mkdirSync(destination, { recursive: true })
  // Always copy the pair from one source; never combine DLL/host versions.
  for (const file of files) copyFileSync(join(source, file), join(destination, file))
  verifyConptyRuntime(destination)
}
