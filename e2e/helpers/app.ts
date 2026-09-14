import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { _electron as electron } from 'playwright'
import { expect } from '@playwright/test'
import type { ElectronApplication, Page } from 'playwright'
// @ts-expect-error cjs helper without types
import requestIpc from '../../scripts/ipc-request.cjs'


export interface OrcSpaceFixture {
  app: ElectronApplication
  page: Page
  profileDir: string
  controlPort: number
  socketPath?: string

  mcpPort: number
  controlToken: string
}



export type ViewportSize = { width: number; height: number }

export interface LaunchOptions {
  profileDir?: string
  viewport?: ViewportSize
}



export const appRoot = path.resolve(process.cwd())


function stripTerminalControls(value: string): string {
  return value




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








export async function launchOrcSpace(options?: LaunchOptions): Promise<OrcSpaceFixture> {
  const mainJs = path.join(appRoot, 'out', 'main', 'index.js')
  if (!fs.existsSync(mainJs)) {
    throw new Error(`Electron entry not built at ${mainJs} — run "npm run build" first.`)
  }



  const profileDir = options?.profileDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'orcspace-e2e-'))
  const controlPort = await freePort()
  const mcpPort = controlPort

  const app = await electron.launch({
    args: [mainJs, `--user-data-dir=${profileDir}`, '--disable-gpu'],
    env: {
      ...process.env,
      ORCSPACE_TEST_USER_DATA: profileDir,
      WORKSPACE_CONTROL_PORT: String(controlPort),
    },
    timeout: 120_000
  })

  const page = await app.firstWindow()
  await app.evaluate(({ BrowserWindow }) => {
    for (const window of BrowserWindow.getAllWindows()) window.setPosition(-20000, 0)
  })
  await page.waitForLoadState('domcontentloaded')

  if (options?.viewport) {
    await page.setViewportSize(options.viewport)
  }

  let controlToken = ''
  for (let i = 0; i < 40 && !controlToken; i++) {
    try {
      controlToken = fs.readFileSync(path.join(profileDir, 'control-token'), 'utf8').trim()
    } catch {

    }
    if (!controlToken) await new Promise((resolve) => setTimeout(resolve, 250))
  }
  if (!controlToken) {
    throw new Error('control token did not appear in the e2e profile — the app may have failed to start')
  }

  return { app, page, profileDir, controlPort, mcpPort, controlToken }
}





export async function waitForCanvas(page: Page): Promise<void> {
  await page.getByTestId('canvas').waitFor({ state: 'visible' })
  await page.locator('#startup-screen').waitFor({ state: 'detached' })
}





export async function controlGet(fixture: Pick<OrcSpaceFixture, 'controlPort' | 'controlToken' | 'socketPath'>, path: string): Promise<any> {
  if (fixture.socketPath) {
    const res = await requestIpc(fixture.socketPath, path, { headers: { 'x-orcspace-token': fixture.controlToken } })
    if (res.status !== 200) throw new Error(`control GET ${path} -> ${res.status}`)
    return res.json
  }
  const res = await fetch(`http://127.0.0.1:${fixture.controlPort}${path}`, {
    headers: { 'x-orcspace-token': fixture.controlToken }
  })
  if (!res.ok) throw new Error(`control GET ${path} -> ${res.status} ${await res.text()}`)
  return res.json()
}






export async function controlSend(
  fixture: OrcSpaceFixture,
  method: 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: unknown
): Promise<{ status: number; json: any }> {
  if (fixture.socketPath) return requestIpc(fixture.socketPath, path, {
    method, body, headers: { 'x-orcspace-token': fixture.controlToken }
  })
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

  }
  return { status: res.status, json }
}


export async function readTerminalOutput(fixture: Pick<OrcSpaceFixture, 'controlPort' | 'controlToken'>, id: string): Promise<string> {




  const data = await controlGet(fixture, `/terminal/${encodeURIComponent(id)}/output?full=1`)
  return typeof data.output === 'string' ? stripTerminalControls(data.output) : ''
}


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


export async function listTerminals(fixture: Pick<OrcSpaceFixture, 'controlPort' | 'controlToken'>): Promise<Array<{ id: string; title: string }>> {
  const data = await controlGet(fixture, '/widgets')
  return (data.widgets ?? []).filter((w: { kind?: string }) => w.kind === 'terminal')
}


export function terminalFrame(page: Page): ReturnType<Page['locator']> {
  return page.locator('[data-testid^="widget-terminal-"]').last()
}


export function terminalFrameById(page: Page, id: string): ReturnType<Page['locator']> {
  return page.locator(`[data-testid="widget-terminal-${id}"]`)
}

export async function waitForTerminalShell(fixture: OrcSpaceFixture, page: Page, knownIds: string[] = []): Promise<string> {
  await terminalFrame(page).waitFor({ state: 'visible' })
  const known = new Set(knownIds)
  const deadline = Date.now() + 30_000
  let terminals = await listTerminals(fixture)
  let fresh = terminals.map((t) => t.id).filter((id) => !known.has(id))
  while (fresh.length === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250))
    terminals = await listTerminals(fixture)
    fresh = terminals.map((t) => t.id).filter((id) => !known.has(id))
  }
  expect(terminals.length).toBeGreaterThan(0)
  const id = fresh[fresh.length - 1] ?? terminals[terminals.length - 1].id
  await waitForTerminalOutput(fixture, id, (output) => output.trim().length > 0)
  return id
}


export async function closeOrcSpace(
  fixture: OrcSpaceFixture | undefined,
  options?: { keepProfile?: boolean }
): Promise<void> {
  if (!fixture) return
  await fixture.app.close().catch(() => {})
  if (!options?.keepProfile) fs.rmSync(fixture.profileDir, { recursive: true, force: true })
}
