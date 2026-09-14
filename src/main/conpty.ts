import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export const windowsPtyOptions = { useConpty: true, useConptyDll: true } as const

/** portable-pty supports a sideloaded conpty.dll via LoadLibrary.
 * Use the same shipped ConPTY as node-pty, not the legacy system conhost
 * which reorders synchronized output and cursor restoration.
 */
export function rustPtyWorkingDirectory(): string {
  if (process.platform !== 'win32') return process.cwd()
  const require = createRequire(import.meta.url)
  const root = dirname(require.resolve('@homebridge/node-pty-prebuilt-multiarch/package.json'))
    .replace(/\.asar([\\/])/, '.asar.unpacked$1')
  for (const build of ['Release', 'Debug']) {
    const directory = join(root, 'build', build, 'conpty')
    if (existsSync(join(directory, 'conpty.dll')) && existsSync(join(directory, 'OpenConsole.exe'))) return directory
  }
  throw new Error('Bundled conpty.dll and OpenConsole.exe are missing')
}
