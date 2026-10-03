import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const packagePath = fileURLToPath(new URL('../package.json', import.meta.url))
const cliPath = fileURLToPath(new URL('../cli/grayspace.mjs', import.meta.url))
const cargoPath = fileURLToPath(new URL('../native/orcspace-app/Cargo.toml', import.meta.url))
const packageVersion = JSON.parse(readFileSync(packagePath, 'utf8')).version
const cliSource = readFileSync(cliPath, 'utf8')
const cliVersion = cliSource.match(/const (?:GRAYSPACE|ORC)_VERSION = '([^']+)'/)?.[1]
const cargoSource = readFileSync(cargoPath, 'utf8')
const cargoVersion = cargoSource.match(/^\[package\][\s\S]*?^version = "([^"]+)"/m)?.[1]

const drift = []
if (!packageVersion || packageVersion !== cliVersion) {
  drift.push(`package.json=${packageVersion ?? '<missing>'}, cli/grayspace.mjs=${cliVersion ?? '<missing>'}`)
}
if (!packageVersion || packageVersion !== cargoVersion) {
  drift.push(`package.json=${packageVersion ?? '<missing>'}, orcspace-app Cargo.toml=${cargoVersion ?? '<missing>'}`)
}

if (drift.length) {
  console.error(`Version drift: ${drift.join('; ')}`)
  process.exit(1)
}

console.log(`Version ${packageVersion} is consistent.`)
