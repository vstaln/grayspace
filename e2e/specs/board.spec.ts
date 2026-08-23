import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, controlGet, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 6 — the kanban board: open from the rail, create a task with Enter,
 * watch it land in a column, close the panel.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('a task created on the board appears in a column', async () => {
  const { page } = ctx
  const title = `e2e-task-${Date.now()}`

  await page.getByTestId('rail-board').click()
  const panel = page.getByTestId('board-panel')
  await expect(panel).toBeVisible()

  await panel.getByTestId('board-task-input').fill(title)
  await panel.getByTestId('board-task-input').press('Enter')

  await expect(panel.getByText(title, { exact: false }).first()).toBeVisible()

  // The task is real: it landed in the coordination store the board renders.
  await expect
    .poll(async () => {
      const data = await controlGet(ctx, '/coordination/tasks')
      return data.tasks.some((t: { title: string }) => t.title === title)
    }, { timeout: 10_000 })
    .toBe(true)

  await panel.getByRole('button', { name: 'Close Task Board' }).click()
  await expect(panel).toHaveCount(0)
})