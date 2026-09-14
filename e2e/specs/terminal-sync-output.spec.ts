import { test, expect } from '@playwright/test'
import path from 'node:path'
import fs from 'node:fs'
import ts from 'typescript'

test('ordered PTY frames keep the cursor visible across delayed transport and live restore', async ({ page }) => {
  await page.setContent('<div id="terminal" style="width:800px;height:400px"></div>')
  await page.addStyleTag({ path: path.resolve('node_modules/@xterm/xterm/css/xterm.css') })
  await page.addScriptTag({ path: path.resolve('node_modules/@xterm/xterm/lib/xterm.js') })
  for (const [file, name] of [['terminalRenderQueue', 'TerminalRenderQueue']]) {
    const source = fs.readFileSync(path.resolve(`src/renderer/src/lib/${file}.ts`), 'utf8').replace(/^export /gm, '')
    await page.addScriptTag({ content: ts.transpile(source + `\nwindow.${name} = ${name}`, { target: ts.ScriptTarget.ES2022 }) })
  }
  const results = await page.evaluate(async () => {
    const api = window as any
    const results: { mode: string; chunkSize: number; wrong: number[]; final: number; invisible: number; blurredVisible: boolean }[] = []
    for (const mode of ['legacy', 'modern', 'restore']) for (const chunkSize of [7, 128]) {
      const term = new api.Terminal({ cols: 80, rows: 20, cursorBlink: false, cursorInactiveStyle: 'outline' })
      term.open(document.getElementById('terminal'))
      term.focus()
      const frames = async (count: number): Promise<void> => {
        for (let i = 0; i < count; i++) await new Promise(requestAnimationFrame)
      }
      const row = (): number => Array.from(document.querySelectorAll('.xterm-rows > div'))
        .findIndex(el => el.querySelector('.xterm-cursor'))
      await new Promise<void>(resolve => term.write('\x1b[2J\x1b[5;1HWorking (esc to interrupt)\x1b[7;1H> Ask Codex\x1b[7;3H', resolve))
      await frames(3)
      let scheduled = false
      let busy = false
      const queue = new api.TerminalRenderQueue((data: string, done: () => void) => {
        busy = true
        term.write(data, () => { busy = false; done() })
      }, () => {
        if (scheduled) return
        scheduled = true
        requestAnimationFrame(() => { scheduled = false; queue.flush() })
      }, 2 * 1024 * 1024, chunkSize)
      const push = (data: string): void => queue.push(data)
      const wrong: number[] = []
      let invisible = 0
      const visible = (): boolean => {
        const cursor = document.querySelector<HTMLElement>('.xterm-cursor')
        if (!cursor) return false
        const style = getComputedStyle(cursor)
        const rect = cursor.getBoundingClientRect()
        const background = style.backgroundColor !== 'rgba(0, 0, 0, 0)' && style.backgroundColor !== 'transparent'
        const outline = style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0
        return style.opacity !== '0' && style.visibility === 'visible' && rect.width > 0 && rect.height > 0 && (background || outline)
      }
      let sampling = true
      const sample = (): void => {
        if (!sampling) return
        const current = row()
        if (current !== 6) wrong.push(current)
        if (!visible()) invisible++
        requestAnimationFrame(sample)
      }
      requestAnimationFrame(sample)
      const prefix = '\x1b[?2026h\x1b[?25l\x1b[4;1H'
      if (mode === 'restore') {
        // A snapshot can end inside a frame. The SAME xterm parser receives
        // its continuation from live output, with no normalization/flush.
        await new Promise<void>(resolve => term.write(prefix, resolve))
      } else push(prefix)
      if (mode === 'legacy') push('\x1b[?25h\x1b[0 q\x1b[?2026l')
      // Longer than both timeouts of the removed renderer workaround.
      await frames(40)
      for (const part of ['\x1b[7;', '3H\x1b[?25', 'h\x1b[0 q', mode === 'legacy' ? '' : '\x1b[?2026l']) push(part)
      while (queue.pendingLength || busy || scheduled) await frames(1)
      await frames(4)
      sampling = false
      const final = row()
      term.blur()
      await frames(3)
      results.push({ mode, chunkSize, wrong, final, invisible, blurredVisible: visible() })
      queue.dispose()
      term.dispose()
      document.getElementById('terminal')!.replaceChildren()
    }
    return results
  })
  expect(results.find(result => result.mode === 'legacy' && result.chunkSize === 128)!.wrong).toContain(3)
  for (const result of results.filter(result => result.mode !== 'legacy')) {
    expect(result.wrong, `parser chunk ${result.chunkSize}`).toEqual([])
    expect(result.final).toBe(6)
    expect(result.invisible).toBe(0)
    expect(result.blurredVisible).toBe(true)
  }
})

test('split synchronized frames never paint temporary cursor positions', async ({ page }) => {
  await page.setContent('<div id="terminal" style="width:800px;height:400px"></div>')
  await page.addStyleTag({ path: path.resolve('node_modules/@xterm/xterm/css/xterm.css') })
  await page.addScriptTag({ path: path.resolve('node_modules/@xterm/xterm/lib/xterm.js') })
  await page.addScriptTag({ path: path.resolve('node_modules/@xterm/addon-fit/lib/addon-fit.js') })
  await page.addScriptTag({ path: path.resolve('node_modules/@xterm/addon-unicode11/lib/addon-unicode11.js') })
  const result = await page.evaluate(async () => {
    const Terminal = (window as any).Terminal
    const term = new Terminal({ cols: 80, rows: 20, cursorBlink: false, allowProposedApi: true })
    const fit = new (window as any).FitAddon.FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new (window as any).Unicode11Addon.Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(document.getElementById('terminal'))
    term.focus()
    const write = (data: string): Promise<void> => new Promise(resolve => term.write(data, resolve))
    const frames = async (): Promise<void> => {
      for (let i = 0; i < 3; i++) await new Promise(requestAnimationFrame)
    }
    const cursorRow = (): number => Array.from(document.querySelectorAll('.xterm-rows > div'))
      .findIndex(row => row.querySelector('.xterm-cursor'))
    await write('\x1b[2J\x1b[5;1HWorking (esc to interrupt)\x1b[7;1H> Ask Codex\x1b[7;3H\x1b[?25h')
    await frames()
    const initial = cursorRow()
    const intermediate: number[] = []
    for (let i = 0; i < 8; i++) {
      // Split both a control sequence and its frame across parser writes.
      await write('\x1b[?202')
      await write('6h\x1b[4;1H\x1b[?25h')
      await frames()
      intermediate.push(cursorRow())
      await write('\x1b[7;3H\x1b[?2026l')
      await frames()
    }
    const final = cursorRow()
    await write('\x1b[?25l')
    await frames()
    const hiddenByApplication = cursorRow()
    await write('\x1b[?25h\x1b[9;1Hshell> ')
    await frames()
    const shell = cursorRow()
    // An interrupted application must not leave rendering stalled forever.
    await write('\x1b[?2026h\x1b[10;1Hrecovered')
    await new Promise(resolve => setTimeout(resolve, 1200))
    await frames()
    const recovered = cursorRow()
    fit.fit()
    const fitted = term.cols > 0 && term.rows > 0
    await write('\x1b[?1049h\x1b[2J\x1b[1;1H😀')
    await frames()
    const alternate = term.buffer.active.type === 'alternate' && term.buffer.active.cursorX === 2
    await write('\x1b[?1049l')
    await frames()
    const normal = term.buffer.active.type === 'normal'
    term.dispose()
    return { initial, intermediate, final, hiddenByApplication, shell, recovered, fitted, alternate, normal }
  })
  expect(result).toEqual({
    initial: 6, intermediate: Array(8).fill(6), final: 6,
    hiddenByApplication: -1, shell: 8, recovered: 9, fitted: true, alternate: true, normal: true
  })
})
