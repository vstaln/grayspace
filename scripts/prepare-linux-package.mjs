import { chmodSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptPath = fileURLToPath(import.meta.url)
const defaultRoot = join(dirname(scriptPath), '..')

export function prepareLinuxPackage(root = defaultRoot) {
  if (process.platform !== 'linux') {
    throw new Error('Linux packages must be prepared in Linux or Docker; cross-builds from this host are not supported.')
  }
  const cli = join(root, 'cli', 'orc')
  const originalMode = statSync(cli).mode & 0o777
  chmodSync(cli, 0o755)
  if ((statSync(cli).mode & 0o111) === 0) throw new Error('Could not mark cli/orc executable for Linux packages.')
  return originalMode
}

if (process.argv[1] && scriptPath === resolve(process.argv[1])) {
  prepareLinuxPackage()
}
