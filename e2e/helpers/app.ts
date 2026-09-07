import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'

/**
 * The whole app under test: the Electron handle, the renderer page, and the
 * isolated profile + ports every instance owns so tests never touch the user's
 * real data, running app, or default control ports.
 */
export interface OrcSpaceFixture {
  app: ElectronApplication
  page: Page
  profileDir: string
  controlPort: number
  /** Legacy alias for controlPort. */
  mcpPort: number
  controlToken: string
}

// Optional viewport size overrides; when supplied the launched app window
// will be resized after startup so tests can assert layout at specific scales.
export type ViewportSize = { width: number; height: number }

export interface LaunchOptions {
  profileDir?: string
  viewport?: ViewportSize
}

// Playwright runs from the package root; cwd avoids ESM/CJS dirname
// differences and keeps this helper compatible with the e2e tsconfig.
export const appRoot = path.resolve(process.cwd())

/** Keep polling comparisons in character space, not raw ANSI byte space. */
function stripTerminalControls(value: string): string {
  return value
    // Preserve the UTF-16 length while hiding terminal controls. An OSC/CSI
    // sequence can be split across PTY chunks; deleting it only after its
    // terminator arrives would shift every later `slice(before)` offset and
    // make command polling race itself. Fixed-width spaces keep offsets stable.
    .replace(/\u001b\][\s\S]*?(?:\u0007|\u001b\\)/g, (match) => ' '.repeat(match.length))
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, (match) => ' '.repeat(match.length))
    .replace(/\u001b[@-_]/g, (match) => ' '.repeat(match.length))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      server.close(() => resolve(port))
    })
  })
}

/**
 * Boots a fresh, isolated OrcSpace from the built `out/` output.
 *
 * - `--user-data-dir` points at a throwaway profile: no real notes/board/state
 *   can leak in.
 * - One free backend port per instance keeps parallel runs isolated.
 */
export async function launchOrcSpace(options?: LaunchOptions): Promise<OrcSpaceFixture> {
  const mainJs = path.join(appRoot, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Electron entry not built at ${mainJs} — run "npm run build" first.`)
  }

  // A caller-supplied profile (a relaunch test, say) is reused as-is so state
  // written by a previous instance is what this one boots from.
  const profileDir = options?.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orcspace-e2e-'))
  const controlPort = await freePort()
  const mcpPort = controlPort

  const app = await electron.launch({
    args: [mainJs, `--user-data-dir=${profileDir}`, '--disable-gpu'],
    env: {
      ...process.env,
      WORKSPACE_CONTROL_PORT: String(controlPort),
    },
    timeout: 120_000
  })

  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')

  if (options?.viewport) {
    await page.setViewportSize(options.viewport)
  }

  let controlToken = ''
  for (let i = 0; i < 40 && !controlToken; i++) {
    try {
      controlToken = fs.readFileSync(path.join(profileDir, 'control-token'), 'utf8').trim()
    } catch {
      // The profile and token are created during app startup.
    }
    if (!controlToken) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!controlToken) {
    throw new Error('control token did not appear in the e2e profile — the app may have failed to start')
  }

  return { app, page, profileDir, controlPort, mcpPort, controlToken }
}

/**
 * Waits for the app to finish first-paint of the canvas (the <main> element
 * with `data-testid="canvas"`). Call after launch before asserting on the UI.
 */
export async function waitForCanvas(page: Page): Promise<void> {
  await page.getByTestId('canvas').waitFor({ state: 'visible' })
}

/**
 * GET against the app's loopback control API. Every read route is token-gated
 * (P1), so the per-instance token from the launch is sent on every request.
 */
export async function controlGet(fixture: OrcSpaceFixture, path: string): Promise<any> {
  const res = await fetch(`http://127.0.0.1:${fixture.controlPort}${path}`, {
    headers: { 'x-orcspace-token': fixture.controlToken }
  })
  if (!res.ok) throw new Error(`control GET ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}

/**
 * Token-authenticated control-API write. Unlike `controlGet`, non-2xx answers
 * are returned to the caller instead of thrown — conflict/backpressure status
 * codes are exactly what several assertions need to see.
 */
export async function controlSend(
  fixture: OrcSpaceFixture,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  const res = await fetch(`http://127.0.0.1:${fixture.controlPort}${path}`, {
    method,
    headers: {
      'x-orcspace-token': fixture.controlToken,
      'content-type': 'application/json'
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    // Empty bodies are legal for some handlers.
  }
  return { status: res.status, json }
}

/** Live pty scrollback of one terminal (reads from the start, never clears). */
export async function readTerminalOutput(fixture: OrcSpaceFixture, id: string): Promise<string> {
  // The normal endpoint is an incremental agent reader. E2E polling needs a
  // stable snapshot: repeated polls must not depend on another reader's
  // offset, and byte-based ring offsets cannot be compared to JS string
  // lengths when the Windows banner contains Cyrillic characters.
  const data = await controlGet(fixture, `/terminal/${encodeURIComponent(id)}/output?full=1`)
  return typeof data.output === 'string' ? stripTerminalControls(data.output) : ''
}

/** Polls the pty buffer until `predicate` matches, for slow shell startup. */
export async function waitForTerminalOutput(
  fixture: OrcSpaceFixture,
  id: string,
  predicate: (output: string) => boolean,
  timeoutMs = 20_000
): Promise<string> {
  const deadline = Date.now() + timeoutMs
  let lastOutput = ''
  while (Date.now() < deadline) {
    const output = await readTerminalOutput(fixture, id)
    lastOutput = output
    if (predicate(output)) return output
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`timed out waiting for terminal ${id} output; last bytes: ${JSON.stringify(lastOutput.slice(-500))}`)
}

/** Terminals currently live in the app, via `GET /widgets` (shells + widgets). */
export async function listTerminals(fixture: OrcSpaceFixture): Promise<Array<{ id: string; title: string }>> {
  const data = await controlGet(fixture, '/widgets')
  return (data.widgets ?? []).filter((w: { kind?: string }) => w.kind === 'terminal')
}

/** The newest terminal widget frame on the canvas. */
export function terminalFrame(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid^="widget-terminal-"]').last()
}

/** Waits for a terminal widget to mount and its pty to spawn a shell. */
export async function waitForTerminalShell(fixture: OrcSpaceFixture, page: Page): Promise<string> {
  await terminalFrame(page).waitFor({ state: 'visible' })
  const terminals = await listTerminals(fixture)
  expect(terminals.length).toBeGreaterThan(0)
  const id = terminals[terminals.length - 1].id
  await waitForTerminalOutput(fixture, id, (output) => output.trim().length > 0)
  return id
}

/** Tears down an instance: close Electron, then drop its throwaway profile. */
export async function closeOrcSpace(
  fixture: OrcSpaceFixture,
  options?: { keepProfile?: boolean }
): Promise<void> {
  await fixture.app.close().catch(() => {})
  if (!options?.keepProfile) fs.rmSync(fixture.profileDir, { recursive: true, force: true })
}
