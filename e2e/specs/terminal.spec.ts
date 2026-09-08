import { test, expect } from '@playwright/test'
import {
  launchOrcSpace,
  waitForCanvas,
  closeOrcSpace,
  terminalFrame,
  waitForTerminalShell,
  waitForTerminalOutput,
  readTerminalOutput,
  listTerminals,
  type OrcSpaceFixture
} from '../helpers/app'






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
    const canvasRect = el.getBoundingClientRect()
    const widgets = Array.from(el.querySelectorAll<HTMLElement>('.widget')).map((widget) => widget.getBoundingClientRect())
    const candidates = [
      { x: 48, y: 72 },
      { x: canvasRect.width - 48, y: 72 },
      { x: 48, y: canvasRect.height - 72 },
      { x: canvasRect.width - 48, y: canvasRect.height - 72 }
    ]
    return candidates.find(({ x, y }) =>
      x >= 0 && y >= 0 && x < canvasRect.width && y < canvasRect.height &&
      !widgets.some((rect) => {
        const px = canvasRect.left + x
        const py = canvasRect.top + y
        return px >= rect.left && px <= rect.right && py >= rect.top && py <= rect.bottom
      })
    ) ?? candidates[0]
  })
  await canvas.click({ button: 'right', position: point })
  await ctx.page.getByTestId('cm-terminal').click()
}

async function closeTerminal(page: OrcSpaceFixture['page']): Promise<void> {
  await terminalFrame(page).getByTestId('widget-close').click()
  await page.getByTestId('confirm-accept').click()
  await expect(terminalFrame(page)).toHaveCount(0)
}

test('a terminal spawns from the canvas menu, runs a command, and closes for real', async () => {
  const { page } = ctx
  const tag = `e2e-${Date.now()}`

  await openTerminalFromCanvas()
  const id = await waitForTerminalShell(ctx, page)


  const frame = terminalFrame(page)
  await frame.getByTestId('terminal-xterm').click()
  await frame.locator('textarea').focus()
  await page.keyboard.type(`echo ${tag}`)
  await page.keyboard.press('Enter')



  await waitForTerminalOutput(ctx, id, (output) => output.includes(tag))




  await frame.getByTestId('widget-close').click()
  await page.getByTestId('confirm-accept').click()
  await expect(terminalFrame(page)).toHaveCount(0)
  await expect
    .poll(async () => (await listTerminals(ctx)).some((t) => t.id === id), { timeout: 10_000 })
    .toBe(false)
})

test('the agent-launch button types the CLI command into the shell', async () => {
  const { page } = ctx

  await openTerminalFromCanvas()
  const id = await waitForTerminalShell(ctx, page)

  const frame = terminalFrame(page)
  await frame.getByTestId('widget-launch-agent').click()



  await waitForTerminalOutput(ctx, id, (output) => output.includes('agy'))
  await closeTerminal(page)
})

test('choosing an agent from the portal menu does not pan the canvas', async () => {
  const { page } = ctx

  await openTerminalFromCanvas()
  await waitForTerminalShell(ctx, page)
  await page.getByTestId('tool-pan').click()

  const world = page.getByTestId('canvas').locator(':scope > div').first()
  const readCamera = () => world.evaluate((el) => (el as HTMLElement).style.transform)

  const before = await readCamera()
  const frame = terminalFrame(page)
  const frameBefore = await frame.boundingBox()
  await frame.getByTestId('widget-agent-menu').click()
  const menu = page.getByRole('menu', { name: 'Agent' })
  await expect(menu).toBeVisible()



  const item = menu.getByRole('menuitem', { name: 'Claude' })
  const box = await item.boundingBox()
  if (!box) throw new Error('agent menu item is not laid out')
  const startX = box.x + box.width / 2
  const startY = box.y + box.height / 2
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 120, startY + 80)
  await expect(menu).toBeVisible()
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/)
  await page.mouse.up()
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
  expect(await readCamera()).toEqual(before)
  expect(await frame.boundingBox()).toEqual(frameBefore)
  await item.click()
  await expect(frame.getByTestId('widget-launch-agent')).toHaveAttribute('aria-label', 'Launch Claude')
  await expect(menu).toHaveCount(0)
  await page.mouse.move(startX + 180, startY + 100)
  expect(await readCamera()).toEqual(before)


  const title = frame.getByTestId('widget-title')
  const titleBox = await title.boundingBox()
  if (!titleBox) throw new Error('widget title is not laid out')
  const dragStartX = titleBox.x + titleBox.width / 2
  const dragStartY = titleBox.y + titleBox.height / 2
  await title.dispatchEvent('pointerdown', {
    button: 0, buttons: 1, clientX: dragStartX, clientY: dragStartY
  })
  await expect(page.locator('body')).toHaveClass(/is-dragging/)
  await page.mouse.move(dragStartX + 200, dragStartY + 120)
  await expect(page.locator('body')).not.toHaveClass(/is-dragging/)
  expect(await frame.boundingBox()).toEqual(frameBefore)



  await frame.getByTestId('widget-agent-menu').click()
  await expect(menu).toBeVisible()
  await page.getByTestId('canvas').evaluate((el) => (el as HTMLElement).focus())
  await page.keyboard.press('ArrowRight')
  await expect(menu).toHaveCount(0)
  await closeTerminal(page)
})

test('Code paste is delivered only to the focused terminal', async () => {
  const { page } = ctx

  await page.getByRole('tab', { name: 'Code' }).click()
  await page.getByRole('button', { name: 'Launch', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Launch Code Session' })
  await dialog.getByRole('button', { name: /Launch 4 terminals/ }).click()

  const textareas = page.getByTestId('code-view').locator('.xterm-helper-textarea')
  await expect(textareas).toHaveCount(4, { timeout: 30_000 })
  await expect
    .poll(async () => (await listTerminals(ctx)).filter((terminal) => terminal.id.startsWith('code-')).length, { timeout: 30_000 })
    .toBe(4)

  const codeTerminals = (await listTerminals(ctx)).filter((terminal) => terminal.id.startsWith('code-'))
  const marker = `CODE_PASTE_${Date.now()}`
  await page.evaluate(async (value) => { await navigator.clipboard.writeText(value) }, marker)
  await textareas.nth(2).focus()
  await page.keyboard.press('Control+Shift+V')

  await expect.poll(async () => {
    const outputs = await Promise.all(codeTerminals.map((terminal) => readTerminalOutput(ctx, terminal.id)))
    return outputs.filter((output) => output.includes(marker)).length
  }, { timeout: 10_000 }).toBe(1)
})
