import { expect, type Locator, type Page } from '@playwright/test'

export type ScenarioShell = 'cmd' | 'powershell' | 'posix'

export const HISTORY_LINES = 160
export const RECOVERY_COMMAND = 'echo recovery-marker'
export const RECOVERY_OUTPUT = 'recovery-marker'

/** Prints old1..old160 so the screen and scrollback are full of history. */
export function historyCommand(shell: ScenarioShell): string {
  if (shell === 'cmd') return `for /L %i in (1,1,${HISTORY_LINES}) do @echo old%i`
  if (shell === 'powershell') return `1..${HISTORY_LINES} | ForEach-Object { "old$_" }`
  return `for i in $(seq 1 ${HISTORY_LINES}); do echo old$i; done`
}

/**
 * A foreground CLI that leaves the terminal the way Codex or Claude does when
 * Ctrl+C kills it mid-frame: alternate screen, mouse tracking, origin mode and
 * a scrolling region all still switched on, nothing switched back.
 */
export function fakeTuiCommand(shell: ScenarioShell): string {
  if (shell === 'posix') {
    return `sh -c 'printf "\\033[?1049h\\033[?1000h\\033[?6h\\033[3;20rTUI-FRAME"; while :; do sleep 0.1; done'`
  }
  // -EncodedCommand quotes identically under cmd.exe and PowerShell.
  const script = "$e=[char]27; [Console]::Write($e+'[?1049h'+$e+'[?1000h'+$e+'[?6h'+$e+'[3;20r'+'TUI-FRAME'); while ($true) { Start-Sleep -Milliseconds 100 }"
  return `powershell -NoProfile -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`
}

/** The text of every rendered terminal row, top to bottom. */
export async function visibleRows(xterm: Locator): Promise<string[]> {
  return xterm.locator('.xterm-rows').evaluate((element) =>
    Array.from(element.children).map((row) => (row.textContent ?? '').replace(/ /g, ' ').trimEnd())
  )
}

/**
 * Where the recovery command landed relative to the history the shell printed
 * before the CLI ran.
 */
export function describePromptPlacement(rows: string[]): {
  lastHistoryRow: number
  commandRow: number
  outputRow: number
  lastContentRow: number
} {
  let lastHistoryRow = -1
  let commandRow = -1
  let outputRow = -1
  let lastContentRow = -1
  rows.forEach((row, index) => {
    if (/(^|\s)old\d+$/.test(row)) lastHistoryRow = index
    if (row.includes(RECOVERY_COMMAND)) commandRow = index
    if (row.trim() === RECOVERY_OUTPUT) outputRow = index
    if (row.trim()) lastContentRow = index
  })
  return { lastHistoryRow, commandRow, outputRow, lastContentRow }
}

export async function typeLine(page: Page, text: string): Promise<void> {
  await page.keyboard.type(text)
  await page.keyboard.press('Enter')
}

/**
 * Full Ctrl+C path: history, scrolled-up viewport, a TUI that dies holding
 * its modes, Ctrl+C, a new command typed right away. The new prompt, the
 * command and its output must all be at the live bottom, below the history —
 * never written over the old lines at the top of the screen.
 */
export async function runInterruptScenario(page: Page, xterm: Locator, shell: ScenarioShell): Promise<void> {
  await xterm.click()
  await typeLine(page, historyCommand(shell))
  await expect.poll(async () => (await visibleRows(xterm)).some((row) => /(^|\s)old160$/.test(row)), { timeout: 30_000 }).toBe(true)

  // Read old scrollback when the CLI starts, as a user often does.
  const box = await xterm.boundingBox()
  if (!box) throw new Error('terminal pane has no box')
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.wheel(0, -10_000)
  await expect.poll(async () => (await visibleRows(xterm)).some((row) => /(^|\s)old160$/.test(row))).toBe(false)

  await typeLine(page, fakeTuiCommand(shell))
  await expect.poll(async () => (await visibleRows(xterm)).some((row) => row.includes('TUI-FRAME')), { timeout: 30_000 }).toBe(true)

  await page.keyboard.press('Control+C')
  await typeLine(page, RECOVERY_COMMAND)

  await expect.poll(async () => describePromptPlacement(await visibleRows(xterm)).outputRow, { timeout: 30_000 }).toBeGreaterThan(-1)
  // Let any late recovery write or resize land before judging the layout.
  await page.waitForTimeout(1_000)
  const rows = await visibleRows(xterm)
  const placement = describePromptPlacement(rows)
  const context = `rows:\n${rows.map((row, index) => `${String(index).padStart(2)}| ${row}`).join('\n')}`
  // The command was typed on the new prompt, below every old line.
  expect(placement.commandRow, context).toBeGreaterThan(placement.lastHistoryRow)
  expect(placement.outputRow, context).toBeGreaterThan(placement.commandRow)
  // Nothing but the next prompt follows the output: the viewport is at the
  // live bottom and the prompt is the last line.
  // (cmd.exe puts one blank line before its prompt.)
  const contentAfterOutput = rows.slice(placement.outputRow + 1).filter((row) => row.trim())
  expect(contentAfterOutput, context).toHaveLength(1)
  expect(placement.lastContentRow, context).toBeGreaterThan(placement.outputRow)
  expect(rows.filter((row) => row.includes(RECOVERY_COMMAND)), context).toHaveLength(1)
}
