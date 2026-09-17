import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const cliPath = fileURLToPath(new URL('../cli/orc.mjs', import.meta.url))
const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
const cliSource = readFileSync(cliPath, 'utf8')
const cliVersion = cliSource.match(/const ORC_VERSION = '([^']+)'/)?.[1]

if (!packageVersion || packageVersion !== cliVersion) {
  console.error(`Version drift: package.json=${packageVersion ?? '<missing>'}, cli/orc.mjs=${cliVersion ?? '<missing>'}`)
  process.exit(1)
}

console.log(`Version ${packageVersion} is consistent.`)
