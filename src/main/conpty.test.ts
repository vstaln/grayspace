import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { conptyStartupOutput, windowsPtyOptions, rustPtyWorkingDirectory } from './conpty.ts'
import { createRustPtySidecar } from './rustPtySidecar.ts'
import { TerminalManager } from './terminals.ts'

const begin = '\x1b[?2026h'
const frameBody = '\x1b[?25l\x1b[2J\x1b[5;1HWorking (esc to interrupt)\x1b[7;1H> Ask Codex\x1b[7;3H\x1b[?25h\x1b[0 q'
const end = '\x1b[?2026l'

for (const backend of ['node', 'rust'] as const) {
  test(`${backend} PTY preserves synchronized frame content and cursor order across a 150ms pause`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orc-conpty-test-'))
    const file = join(directory, 'frame.cjs')
    writeFileSync(file, `setTimeout(() => { process.stdout.write(${JSON.stringify(begin + frameBody)}); setTimeout(() => { process.stdout.write(${JSON.stringify(end)}); setTimeout(() => process.exit(), 150) }, 150) }, 150)`)
    let dispose = (): void => {}
    try {
      assert.ok(rustPtyWorkingDirectory().endsWith('conpty'))
      let output = ''
      let send: (data: string) => void = () => {}
      let finish!: () => void
      const finished = new Promise<void>(resolve => { finish = resolve })
      const answerStartup = conptyStartupOutput(data => send(data))
      const receive = (data: string): void => {
        // Answer the host exactly the way the app does, so this test cannot
        // pass on a handshake reply the real terminal never sends.
        output += answerStartup(data)
        if (output.includes(end)) finish()
      }
      if (backend === 'node') {
        const child = pty.spawn(process.execPath, [file], { ...windowsPtyOptions, cols: 80, rows: 20, cwd: process.cwd(), env: process.env as Record<string, string> })
        dispose = () => child.kill()
        send = data => child.write(data)
        child.onData(receive)
      } else {
        const sidecar = createRustPtySidecar({ force: true })
        assert.ok(sidecar, 'build the native engine before running this integration test')
        dispose = () => sidecar.close()
        const id = 'cursor-order'
        send = data => { void sidecar.write(id, data) }
        sidecar.on('data', (eventId: string, data: string) => { if (eventId === id) receive(data) })
        assert.equal(sidecar.spawn({ id, shell: 'cmd.exe', cols: 80, rows: 20, cwd: process.cwd(), env: process.env as Record<string, string> }).ok, true)
        assert.equal((await sidecar.write(id, `"${process.execPath}" "${file}"\r`)).ok, true)
      }
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([finished, new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('no synchronized frame received')), 12000) })])
        assert.ok(output.includes(begin + frameBody + end), 'PTY must preserve the complete frame verbatim, including cursor restoration before sync-end')
      } finally { clearTimeout(timeout) }
    } finally {
      dispose()
      unlinkSync(file)
      rmdirSync(directory)
    }
  })
}

// Regression: a ConPTY host opens by asking the terminal who it is, and
// withholds every byte the shell writes until that is answered — the bundled
// host over its DA1, and a pseudoconsole created with
// PSEUDOCONSOLE_INHERIT_CURSOR (what portable-pty, and therefore the Rust
// engine, always does) over the cursor position. No terminal is attached here,
// which is the whole point: the answer used to come only from xterm.js in the
// renderer, so a terminal appeared on the canvas and then sat blank for
// seconds while the query made the round trip. The manager has to reach a
// prompt on its own now, on either backend.
for (const backend of ['node', 'rust'] as const) {
  test(`${backend} PTY reaches the shell without the terminal answering the cursor query`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const sidecar = backend === 'rust' ? createRustPtySidecar({ force: true }) : null
    if (backend === 'rust') assert.ok(sidecar, 'build the native engine before running this integration test')
    const terminals = new TerminalManager({ rustPty: sidecar })
    const id = `handshake-${backend}`
    try {
      let output = ''
      let finish!: () => void
      const gotShellOutput = new Promise<void>((resolve) => { finish = resolve })
      terminals.on('data', (eventId: string, data: string) => {
        if (eventId !== id) return
        // Nothing is answered here on purpose: the manager has to complete the
        // handshake by itself, without a terminal attached.
        output += data
        // The prompt only exists once the host has released the shell. cmd
        // echoes the path with the casing Windows hands it, which is not
        // necessarily the casing of process.cwd().
        if (output.toLowerCase().includes(`${process.cwd().toLowerCase()}>`)) finish()
      })
      assert.equal(terminals.spawn(id, 80, 20, process.cwd()).ok, true)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          gotShellOutput,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('shell prompt did not arrive within 1.5s; startup handshake stalled')), 1500)
          })
        ])
      } finally { clearTimeout(timeout) }
    } finally {
      terminals.disposeAll()
      sidecar?.close()
    }
  })
}
