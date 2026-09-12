import { test, expect } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { launchOrcSpace, closeOrcSpace, waitForCanvas, listTerminals, readTerminalOutput } from '../helpers/app'
import { launchPackaged } from '../helpers/packaged'

async function launch() {
  if (process.env.ORCSPACE_PACKAGED) return launchPackaged()
  const ctx = await launchOrcSpace()
  return { ...ctx, close: () => closeOrcSpace(ctx) }
}

test('all configured AI terminals preserve identity, Unicode, input and image routing after resize', async () => {
  test.skip(process.platform !== 'win32', 'Windows CLI wrapper and keybinding regression')
  test.setTimeout(120_000)
  const ctx = await launch()
  const receiver = path.join(ctx.profileDir, 'terminal-fixture.cjs')
  fs.writeFileSync(receiver, `
    const fs = require('node:fs');
    const [id, output] = process.argv.slice(2);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdout.write('\\x1b[?1049h\\x1b[?2004h\\x1b[32mREADY '+id+'\\x1b[0m\\r\\nUnicode: русский 日本語 ✓\\r\\nReference to codex must not change this CLI.\\r\\n');
    process.stdin.on('data', data => fs.appendFileSync(output, data));
    process.stdout.on('resize', () => process.stdout.write('\\r\\nRESIZED '+process.stdout.columns+'x'+process.stdout.rows+'\\r\\n'));
  `)
  try {
    await waitForCanvas(ctx.page)
    await ctx.page.getByRole('tab', { name: 'Code', exact: true }).click()
    const cdp = await ctx.page.context().newCDPSession(ctx.page)
    for (const [agent, shortcut] of [
      ['claude', '\x1bv'], ['codex', '\x16'], ['antigravity', '\x16'],
      ['grok', '\x1bv'], ['opencode', '\x16'], ['kimi', '\x1bv'],
      ['cursor', '\x16'], ['commandcode', '\x1bv'], ['pi', '\x1bv']
    ]) {
      const output = path.join(ctx.profileDir, `${agent}.input`)
      const wrapper = path.join(ctx.profileDir, `${agent}.cmd`)
      fs.writeFileSync(wrapper, `@echo off\r\n"${process.execPath}" "${receiver}" "${agent}" "${output}"\r\n`)
      const known = new Set((await listTerminals(ctx)).map(terminal => terminal.id))
      await ctx.page.getByRole('button', { name: 'Other CLI', exact: true }).click()
      const dialog = ctx.page.getByRole('dialog', { name: 'Launch Code Session' })
      await dialog.getByRole('button', { name: 'Other CLI', exact: true }).click()
      await dialog.getByRole('textbox').fill(`"${wrapper}"`)
      await dialog.getByRole('button', { name: /Launch 1 terminal/ }).click()
      await expect.poll(async () => (await listTerminals(ctx)).filter(terminal => !known.has(terminal.id)).length).toBe(1)
      const id = (await listTerminals(ctx)).find(terminal => !known.has(terminal.id))!.id
      const target = ctx.page.getByTestId('code-view').getByTestId('terminal-xterm')
      await expect(target).toHaveCount(1)
      await expect.poll(() => readTerminalOutput(ctx, id).catch(() => '')).toContain(`READY ${agent}`)
      await expect(target.locator('.xterm-rows')).toContainText('Reference to codex')
      await expect(target.locator('.xterm-rows')).toContainText('русский 日本語')
      await ctx.page.getByRole('button', { name: 'Expand session', exact: true }).click()
      await ctx.page.getByRole('tab', { name: 'Canvas', exact: true }).click()
      await ctx.page.getByRole('tab', { name: 'Code', exact: true }).click()
      await ctx.page.getByRole('button', { name: 'Restore session', exact: true }).click()
      const box = (await target.boundingBox())!
      expect(box.width).toBeGreaterThan(100)
      expect(box.height).toBeGreaterThan(100)
      const data = { items: [], files: [path.resolve('assets/icons/orc-logo-32.png')], dragOperationsMask: 1 }
      for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
        await cdp.send('Input.dispatchDragEvent', { type, x: box.x + 50, y: box.y + 50, data })
      }
      await expect.poll(() => fs.existsSync(output) && fs.readFileSync(output, 'utf8').includes(process.platform === 'win32' ? shortcut : '\x16')).toBe(true)
      await target.locator('textarea').focus()
      await ctx.page.keyboard.type('INPUT_CHECK')
      await expect.poll(() => fs.readFileSync(output, 'utf8')).toContain('INPUT_CHECK')
      await ctx.page.getByRole('button', { name: 'Close session', exact: true }).click()
      await expect(target).toHaveCount(0)
      await expect.poll(() => ctx.page.evaluate(async () => (await window.api.code.load()).sessions.length)).toBe(0)
    }
  } finally {
    await ctx.close()
  }
})

test('real file drag reaches the Code terminal through Electron webUtils', async () => {
  const ctx = await launch()
  const file = path.join(ctx.profileDir, 'drop файл with spaces.txt')
  fs.writeFileSync(file, 'attachment regression fixture')
  try {
    await waitForCanvas(ctx.page)
    await ctx.page.locator('#startup-screen').waitFor({ state: 'detached' })
    await ctx.page.getByRole('tab', { name: 'Code', exact: true }).click()
    await ctx.page.getByRole('button', { name: 'Other CLI', exact: true }).click()
    const dialog = ctx.page.getByRole('dialog', { name: 'Launch Code Session' })
    await dialog.getByRole('button', { name: 'Other CLI', exact: true }).click()
    await dialog.getByRole('textbox').fill(process.platform === 'win32' ? 'cmd /d' : 'sh')
    await dialog.getByRole('button', { name: /Launch 1 terminal/ }).click()
    await expect.poll(async () => (await listTerminals(ctx)).filter(t => t.id.startsWith('code-')).length).toBe(1)
    const terminal = (await listTerminals(ctx)).find(t => t.id.startsWith('code-'))!
    const target = ctx.page.getByTestId('code-view').getByTestId('terminal-xterm')
    await expect(target).toBeVisible()
    await expect.poll(() => readTerminalOutput(ctx, terminal.id)).toContain(process.platform === 'win32' ? 'Microsoft' : '$')
    const bounds = (await target.boundingBox())!
    const cdp = await ctx.page.context().newCDPSession(ctx.page)
    const data = { items: [], files: [file], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x: bounds.x + 50, y: bounds.y + 50, data })
    }
    await expect.poll(() => readTerminalOutput(ctx, terminal.id)).toContain('drop файл with spaces.txt')
    expect(await readTerminalOutput(ctx, terminal.id)).not.toContain('Could not attach')
  } finally {
    await ctx.close()
  }
})

test('live Claude Code accepts an image drop without submitting a prompt', async () => {
  test.skip(process.env.ORCSPACE_LIVE_CLI_TEST !== '1', 'Requires local Claude Code configuration')
  const ctx = await launch()
  try {
    await waitForCanvas(ctx.page)
    await ctx.page.locator('#startup-screen').waitFor({ state: 'detached' })
    await ctx.page.evaluate((directory) => window.api.workspace.openRecent(directory), process.cwd())
    await ctx.page.getByRole('tab', { name: 'Code', exact: true }).click()
    await ctx.page.getByRole('button', { name: 'Claude Code', exact: true }).click()
    await ctx.page.getByRole('button', { name: 'Launch 1 sessions', exact: true }).click()
    await expect.poll(async () => (await listTerminals(ctx)).filter(t => t.id.startsWith('code-')).length).toBe(1)
    const terminal = (await listTerminals(ctx)).find(t => t.id.startsWith('code-'))!
    await expect.poll(async () => (await readTerminalOutput(ctx, terminal.id)).replace(/\s+/g, ' '), { timeout: 30_000 }).toMatch(/for shortcuts|Try |help for help/)
    const target = ctx.page.getByTestId('code-view').getByTestId('terminal-xterm')
    await target.locator('textarea').focus()
    await ctx.page.keyboard.type('codex')
    await expect(target.locator('.xterm-rows')).toContainText('codex')
    const bounds = (await target.boundingBox())!
    const cdp = await ctx.page.context().newCDPSession(ctx.page)
    const data = { items: [], files: [path.resolve('assets/icons/orc-logo-32.png')], dragOperationsMask: 1 }
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await cdp.send('Input.dispatchDragEvent', { type, x: bounds.x + 50, y: bounds.y + 50, data })
    }
    await expect.poll(async () => /\[Image\s*#?\d+\]/i.test(await readTerminalOutput(ctx, terminal.id)), { timeout: 15_000 }).toBe(true)
  } finally {
    await ctx.close()
  }
})
