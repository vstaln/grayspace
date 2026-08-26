import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  type OrcSpaceFixture
} from '../helpers/app'

/**
 * The wheel must actually move a terminal's scrollback.
 *
 * Two bugs made this impossible and neither is visible from the terminal code
 * alone: WidgetFrame stopped the wheel event in a React *capture* handler
 * (React delegates to the root container, so that killed native propagation
 * before any listener inside the widget saw the tick), and TerminalWidget then
 * handed every tick to the child process as a mouse report whenever a TUI had
 * turned mouse tracking on — which the normal buffer's scrollback should not do.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('the wheel scrolls terminal scrollback, even while a TUI tracks the mouse', async () => {
  const { page } = ctx

  // The rail's new-terminal button (double-click-to-spawn was removed by
  // design — an empty canvas no longer creates widgets on click).
  await page.getByTestId('rail-new-terminal').click()
  const id = await waitForTerminalShell(ctx, page)

  const frame = terminalFrame(page)
  await frame.getByTestId('terminal-xterm').click()
  await frame.locator('textarea').focus()

  // Enough output to fill the pane many times over, so there is scrollback to
  // move, then mouse tracking on (1000/1006) exactly as Claude Code turns it on.
  await page.keyboard.type('cmd /c "for /L %i in (1,1,200) do @echo line%i"')
  await page.keyboard.press('Enter')
  await waitForTerminalOutput(ctx, id, (output) => output.includes('line200'))
  await page.keyboard.type(
    'powershell -NoProfile -Command "[Console]::Write([char]27+\'[?1000h\'+[char]27+\'[?1006h\')"'
  )
  await page.keyboard.press('Enter')

  const viewport = frame.locator('.xterm-viewport')
  await expect.poll(async () => viewport.evaluate((el) => el.scrollTop)).toBeGreaterThan(0)
  const bottom = await viewport.evaluate((el) => el.scrollTop)

  const box = await frame.getByTestId('terminal-xterm').boundingBox()
  if (!box) throw new Error('terminal pane has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -400)

  // Scrolled up and stayed there — the tick reached the terminal instead of
  // being swallowed by the frame or forwarded to the shell.
  await expect.poll(async () => viewport.evaluate((el) => el.scrollTop)).toBeLessThan(bottom)

  await page.mouse.wheel(0, 400)
  // Back at the bottom — measured live, not against the `bottom` snapshot
  // taken above. The shell is still emitting (the powershell prompt returns
  // after that snapshot), so the buffer can grow in between and the real
  // bottom moves with it; comparing to the stale number made this assertion
  // fail perhaps one run in three.
  await expect
    .poll(async () =>
      viewport.evaluate((el) => Math.abs(el.scrollTop - (el.scrollHeight - el.clientHeight)) <= 1)
    )
    .toBe(true)
})
