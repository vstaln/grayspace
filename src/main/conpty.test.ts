import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as pty from '@homebridge/node-pty-prebuilt-multiarch'
import { windowsPtyOptions, rustPtyWorkingDirectory } from './conpty.ts'
import { createRustPtySidecar } from './rustPtySidecar.ts'

const begin = '\x1b[?2026h'
const frameBody = '\x1b[?25l\x1b[2J\x1b[5;1HWorking (esc to interrupt)\x1b[7;1H> Ask Codex\x1b[7;3H\x1b[?25h\x1b[0 q'
const end = '\x1b[?2026l'
const frame = begin + frameBody + end

for (const backend of ['node', 'rust'] as const) {
  test(`${backend} PTY preserves synchronized frame and cursor order across a 150ms pause`, { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
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
        assert.ok(output.includes(frame), 'PTY must preserve the complete frame verbatim, including cursor restoration before sync-end')
      } finally { clearTimeout(timeout) }
    } finally {
      dispose()
      unlinkSync(file)
      rmdirSync(directory)
    }
  })
}
