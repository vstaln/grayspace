import { spawnSync } from 'node:child_process'

const args = process.argv.slice(2)
const hasMsvcLinker = process.platform !== 'win32' || spawnSync('where.exe', ['link.exe'], { stdio: 'ignore' }).status === 0

const command = hasMsvcLinker ? 'cargo' : 'rustup'
const commandArgs = hasMsvcLinker
  ? args
  : ['run', 'stable-x86_64-pc-windows-gnu', 'cargo', ...args]
const result = spawnSync(command, commandArgs, { stdio: 'inherit', shell: false })

if (result.error) {
  console.error(`native cargo failed: ${result.error.message}`)
  process.exit(1)
}
process.exit(result.status ?? 1)
