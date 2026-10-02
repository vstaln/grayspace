import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  listTerminals,
  waitForTerminalShell,
  waitForTerminalOutput,
  type OrcSpaceFixture
} from '../helpers/app'
import { runInterruptScenario, type ScenarioShell } from '../helpers/interruptScenario'











let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

async function openTerminalFromCanvas(): Promise<void> {
  const canvas = ctx.page.getByTestId('canvas')
  const point = await canvas.evaluate((el) => {
    const rect = el.getBoundingClientRect()
    const widgets = Array.from(el.querySelectorAll<HTMLElement>('.widget')).map((widget) => widget.getBoundingClientRect())
    const candidates = [
      { x: 48, y: 72 },
      { x: rect.width - 48, y: 72 },
      { x: 48, y: rect.height - 72 },
      { x: rect.width - 48, y: rect.height - 72 }
    ]
    return candidates.find(({ x, y }) =>
      x >= 0 && y >= 0 && x < rect.width && y < rect.height &&
      !widgets.some((widget) => {
        const px = rect.left + x
        const py = rect.top + y
        return px >= widget.left && px <= widget.right && py >= widget.top && py <= widget.bottom
      })
    ) ?? candidates[0]
  })
  await canvas.click({ button: 'right', position: point })
  await ctx.page.getByTestId('cm-terminal').click()
}

async function closeTerminal(page: OrcSpaceFixture['page']): Promise<void> {
  const terminals = page.locator('[data-testid^="widget-terminal-"]')
  while (await terminals.count()) {
    const before = await terminals.count()
    await terminalFrame(page).getByTestId('widget-close').click()
    await page.getByTestId('confirm-accept').click()
    await expect(terminals).toHaveCount(before - 1)
  }
}

test('the wheel scrolls terminal scrollback, even while a TUI tracks the mouse', async () => {
  const { page } = ctx



  await page.getByTestId('canvas').click({ button: 'right', position: { x: 420, y: 260 } })
  await page.getByTestId('cm-terminal').click()
  const id = await waitForTerminalShell(ctx, page)

  const frame = terminalFrame(page)
  await frame.getByTestId('terminal-xterm').click()
  await frame.locator('textarea').focus()



  await page.keyboard.type('cmd /c "for /L %i in (1,1,200) do @echo line%i"')
  await page.keyboard.press('Enter')
  await waitForTerminalOutput(ctx, id, (output) => output.includes('line200'))
  await page.keyboard.type(
    'powershell -NoProfile -Command "[Console]::Write([char]27+\'[?1000h\'+[char]27+\'[?1006h\')"'
  )
  await page.keyboard.press('Enter')
  await page.keyboard.type('echo TRACKING_READY')
  await page.keyboard.press('Enter')



  await waitForTerminalOutput(ctx, id, (output) => output.includes('TRACKING_READY'))

  // xterm 6 virtualizes scrolling; DOM scrollTop no longer tracks scrollback.
  // Check the lines the user actually sees instead.
  const rows = frame.locator('.xterm-rows')
  await expect(rows).toContainText('TRACKING_READY')
  const firstVisibleLine = async (): Promise<number> => rows.evaluate(el => {
    for (const row of Array.from(el.children)) {
      const match = /^line(\d+)\s*$/.exec(row.textContent ?? '')
      if (match) return Number(match[1])
    }
    return -1
  })
  await expect.poll(firstVisibleLine).toBeGreaterThan(1)
  const bottom = await firstVisibleLine()

  const box = await frame.getByTestId('terminal-xterm').boundingBox()
  if (!box) throw new Error('terminal pane has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)



  await expect.poll(firstVisibleLine).toBeGreaterThan(0)
  await expect.poll(firstVisibleLine).toBeLessThan(bottom)

  await page.mouse.wheel(0, 400)





  await expect.poll(firstVisibleLine).toBe(bottom)
})

const interruptShells: ScenarioShell[] = process.platform === 'win32' ? ['cmd', 'powershell'] : ['posix']

for (const shell of interruptShells) {
  test(`Ctrl+C after a TUI leaves the next ${shell} prompt and command at the live bottom`, async () => {
    const { page } = ctx
    if (process.platform === 'win32') {
      await page.evaluate((windowsShell) => window.api.settings.set({ windowsShell }), shell as 'cmd' | 'powershell')
    }
    try {
      const knownBefore = (await listTerminals(ctx)).map((terminal) => terminal.id)
      await openTerminalFromCanvas()
      await waitForTerminalShell(ctx, page, knownBefore)
      await runInterruptScenario(page, terminalFrame(page).getByTestId('terminal-xterm'), shell)
    } finally {
      if (process.platform === 'win32') await page.evaluate(() => window.api.settings.set({ windowsShell: 'cmd' }))
      await closeTerminal(page)
    }
  })
}
