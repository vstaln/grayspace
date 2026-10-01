import { existsSync } from 'fs'
import { join } from 'path'
import puppeteer, { type Browser, type Page } from 'puppeteer-core'
import { getUserDataDir } from './userData.ts'
import type { BrowserAgentAction, BrowserAgentResponse } from '../preload/api.ts'
import {
  assertRefInRange,
  clickScript,
  fillScript,
  isProtectedCheckoutUrl,
  pressFocusScript,
  pressKeyScript,
  scrollScript,
  selectScript,
  snapshotScript,
  SUPPORTED_PRESS_KEYS
} from '../shared/browserActionScripts.ts'

/**
 * Drives the user's real, installed Chrome — a separate, visible window the
 * user watches an agent act in, as opposed to BrowserWidget's in-app
 * `<webview>` on the canvas. It runs a dedicated automation profile (its own
 * `--user-data-dir` under the app's user-data folder) rather than the user's
 * everyday Chrome profile: Chrome refuses to let a second process attach to
 * a profile directory that's already open without the debugging flag from
 * launch, so reusing the default profile live would mean force-closing the
 * user's existing Chrome windows first. This keeps their regular browsing
 * session untouched while still being genuinely their Chrome binary, with a
 * real new tab opening and typing in front of them.
 */

let browserPromise: Promise<Browser> | null = null
const pages = new Map<string, Page>()

function candidateChromePaths(): string[] {
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
    const localAppData = process.env['LOCALAPPDATA'] || ''
    return [
      join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      ...(localAppData ? [join(localAppData, 'Google\\Chrome\\Application\\chrome.exe')] : [])
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      join(process.env.HOME || '', 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium-browser',
    '/usr/bin/chromium',
    '/snap/bin/chromium'
  ]
}

function findChromeExecutable(): string | null {
  for (const candidate of candidateChromePaths()) {
    try {
      if (candidate && existsSync(candidate)) return candidate
    } catch {
      // Keep checking the remaining candidates.
    }
  }
  return null
}

async function getBrowser(): Promise<Browser> {
  if (browserPromise) return browserPromise
  const executablePath = findChromeExecutable()
  if (!executablePath) {
    throw new Error('Google Chrome was not found on this computer — install it to let an agent browse in a real window.')
  }
  browserPromise = puppeteer
    .launch({
      executablePath,
      headless: false,
      userDataDir: join(getUserDataDir(), 'chrome-automation-profile'),
      defaultViewport: null,
      args: ['--no-first-run', '--no-default-browser-check', '--window-size=1280,900']
    })
    .then((browser) => {
      browser.once('disconnected', () => {
        browserPromise = null
        pages.clear()
      })
      return browser
    })
    .catch((err) => {
      browserPromise = null
      throw err
    })
  return browserPromise
}

function requireOpenPage(id: string): Page {
  const page = pages.get(id)
  if (!page || page.isClosed()) throw new Error('real browser tab is not open; open it first')
  return page
}

export async function openRealBrowserTab(id: string, url?: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    if (url !== undefined && (!/^https?:\/\//i.test(url) || isProtectedCheckoutUrl(url))) {
      return { ok: false, error: url && isProtectedCheckoutUrl(url) ? 'checkout navigation is disabled' : 'only http and https addresses are allowed' }
    }
    const existing = pages.get(id)
    const browser = await getBrowser()
    const page = existing && !existing.isClosed() ? existing : await browser.newPage()
    if (!existing) {
      pages.set(id, page)
      page.once('close', () => {
        if (pages.get(id) === page) pages.delete(id)
      })
    }
    await page.bringToFront()
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function realBrowserAction(id: string, action: BrowserAgentAction): Promise<BrowserAgentResponse> {
  try {
    if (action.kind === 'navigate') {
      const opened = await openRealBrowserTab(id, action.url)
      return opened.ok ? { ok: true, result: { url: action.url } } : { ok: false, error: opened.error }
    }
    const page = requireOpenPage(id)
    let result: unknown
    switch (action.kind) {
      case 'snapshot':
        result = await page.evaluate(snapshotScript())
        break
      case 'click':
        assertRefInRange(Number(action.ref))
        result = await page.evaluate(clickScript(Number(action.ref)))
        await new Promise((resolve) => setTimeout(resolve, 350))
        break
      case 'select':
        assertRefInRange(Number(action.ref))
        if (action.value.length > 4000) throw new Error('selection is too long')
        result = await page.evaluate(selectScript(Number(action.ref), action.value))
        break
      case 'fill':
        assertRefInRange(Number(action.ref))
        if (action.value.length > 4000) throw new Error('text is too long')
        result = await page.evaluate(fillScript(Number(action.ref), action.value))
        break
      case 'press': {
        if (!(SUPPORTED_PRESS_KEYS as readonly string[]).includes(action.key)) throw new Error('unsupported key')
        if (action.ref) {
          assertRefInRange(Number(action.ref))
          await page.evaluate(pressFocusScript(Number(action.ref)))
        }
        result = await page.evaluate(pressKeyScript(action.key))
        break
      }
      case 'scroll': {
        const pixels = Math.max(-1200, Math.min(1200, Number(action.pixels) || 0))
        result = await page.evaluate(scrollScript(pixels))
        break
      }
      default:
        throw new Error('unsupported browser action')
    }
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export function isRealBrowserTabOpen(id: string): boolean {
  const page = pages.get(id)
  return Boolean(page && !page.isClosed())
}

/** Best-effort cleanup on app shutdown; the automation profile is durable, so a failed close just leaves the window up for the user to close by hand. */
export function closeRealBrowser(): void {
  if (!browserPromise) return
  void browserPromise.then((browser) => browser.close()).catch(() => {})
  browserPromise = null
  pages.clear()
}
