import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { windowsPtyOptions, rustPtyWorkingDirectory } from './conpty.ts'
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
      const receive = (data: string): void => {
        output += data
        if (output.includes('\x1b[6n') && !output.includes(begin)) send('\x1b[1;1R')
        if (data.includes('\x1b[c')) send('\x1b[?1;2c')
        if (output.includes(end)) finish()
      }
      if (backend === 'node') {
        const child = pty.spawn(process.execPath, [file], { ...windowsPtyOptions, cols: 80, rows: 20, cwd: process.cwd(), env: process.env as Record<string, string> })
        dispose = () => child.kill()
        send = data => child.write(data)
        child.onData(receive)
      } else {
        const sidecar = createRustPtySidecar()
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
        const orderedFrameParts = [begin, 'Working (esc to interrupt)', '> Ask Codex', '\x1b[?25h', end]
        let offset = 0
        for (const part of orderedFrameParts) {
          const found = output.indexOf(part, offset)
          assert.notEqual(found, -1, `PTY output is missing synchronized frame part ${JSON.stringify(part)}`)
          offset = found + part.length
        }
      } finally { clearTimeout(timeout) }
    } finally {
      dispose()
      unlinkSync(file)
      rmdirSync(directory)
    }
  })
}

// Regression: a ConPTY created with PSEUDOCONSOLE_INHERIT_CURSOR — which is
// what portable-pty, and therefore the Rust engine, always does — opens by
// asking the terminal where the cursor is (`ESC [ 6 n`) and withholds every
// byte the shell writes until that is answered. Nothing here ever answers it,
// which is the whole point: the answer used to come only from xterm.js in the
// renderer, so a terminal appeared on the canvas and then sat blank for
// seconds while the query made the round trip. node-pty does not set the flag
// and is covered here to keep that difference from silently changing.
for (const backend of ['node', 'rust'] as const) {
  test(`${backend} PTY reaches the shell without the terminal answering the cursor query`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
    const sidecar = backend === 'rust' ? createRustPtySidecar() : null
    if (backend === 'rust') assert.ok(sidecar, 'build the native engine before running this integration test')
    const terminals = new TerminalManager({ rustPty: sidecar })
    const id = `handshake-${backend}`
    try {
      let output = ''
      let finish!: () => void
      const gotShellOutput = new Promise<void>((resolve) => { finish = resolve })
      terminals.on('data', (eventId: string, data: string) => {
        if (eventId !== id) return
        output += data
        // Anything beyond the query itself only exists once ConPTY has been
        // released by a cursor report.
        if (output.replace('\x1b[6n', '').trim().length > 0) finish()
      })
      assert.equal(terminals.spawn(id, 80, 20, process.cwd()).ok, true)
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          gotShellOutput,
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error('shell produced no output; the ConPTY handshake was never answered')), 5000)
          })
        ])
      } finally { clearTimeout(timeout) }
    } finally {
      terminals.disposeAll()
      sidecar?.close()
    }
  })
}
