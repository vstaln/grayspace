import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// The system ConPTY starts a shell immediately. The bundled OpenConsole host
// has a several-second startup pause on some Windows builds, so it must not be
// the normal path. Keep the bundled host as a compatibility fallback below.
export const windowsPtyOptions = { useConpty: true, useConptyDll: false } as const
export const bundledWindowsPtyOptions = { useConpty: true, useConptyDll: true } as const

/** portable-pty supports a sideloaded conpty.dll via LoadLibrary. */
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

// node-pty is deliberately not primed the way the Rust engine is (see
// prime_conpty_handshake in native/orcspace-app/src/engine.rs): it creates its
// pseudoconsole without PSEUDOCONSOLE_INHERIT_CURSOR, so conhost never asks
// the terminal where the cursor is and never withholds the shell's output
// waiting for an answer. Sending an unsolicited cursor report here would only
// push bytes at a ConPTY that never asked for them.
