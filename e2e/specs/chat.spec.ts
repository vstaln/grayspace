import { test, expect } from '@playwright/test'
import { launchOrcSpace, waitForCanvas, closeOrcSpace, type OrcSpaceFixture } from '../helpers/app'

/**
 * Journey 9 — Chat Pane view switching, thread management, and UI rendering.
 */
let ctx: OrcSpaceFixture

test.beforeAll(async () => {
  ctx = await launchOrcSpace()
  await waitForCanvas(ctx.page)
})

test.afterAll(async () => {
  await closeOrcSpace(ctx)
})

test('switches to Chat view and interacts with chat pane', async () => {
  const { page } = ctx

  // Click on Chat tab in TitleBar
  const chatTab = page.getByRole('tab', { name: 'Chat' })
  await expect(chatTab).toBeVisible()
  await chatTab.click()

  // Chat pane should be visible
  const chatPaneHeading = page.getByText(/Assistant|Codex|Chat/)
  await expect(chatPaneHeading.first()).toBeVisible()

  // Textarea input is present
  const input = page.locator('textarea')
  await expect(input).toBeVisible()

  // Type a test prompt and submit
  const draft = `Hello agent test ${Date.now()}`
  await input.fill(draft)
  await input.press('Enter')

  // User bubble should appear with the draft text
  await expect(page.getByText(draft)).toBeVisible({ timeout: 5000 })

  // Switch back to Canvas
  const canvasTab = page.getByRole('tab', { name: 'Canvas' })
  await canvasTab.click()
  await expect(page.getByTestId('canvas')).toBeVisible()
})