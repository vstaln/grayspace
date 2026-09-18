import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const cliPath = fileURLToPath(new URL('../cli/orc.mjs', import.meta.url))
const snapshotPath = fileURLToPath(new URL('../src/main/linkSnapshot.ts', import.meta.url))
const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
const cliSource = readFileSync(cliPath, 'utf8')
const cliVersion = cliSource.match(/const ORC_VERSION = '([^']+)'/)?.[1]
const snapshotSource = readFileSync(snapshotPath, 'utf8')
const fallbackVersion = snapshotSource.match(/PACKAGE_FALLBACK_VERSION = '([^']+)'/)?.[1]

const drift = []
if (!packageVersion || packageVersion !== cliVersion) {
  drift.push(`package.json=${packageVersion ?? '<missing>'}, cli/orc.mjs=${cliVersion ?? '<missing>'}`)
}
if (!packageVersion || packageVersion !== fallbackVersion) {
  drift.push(`package.json=${packageVersion ?? '<missing>'}, linkSnapshot fallback=${fallbackVersion ?? '<missing>'}`)
}

if (drift.length) {
  console.error(`Version drift: ${drift.join('; ')}`)
  process.exit(1)
}

console.log(`Version ${packageVersion} is consistent.`)
