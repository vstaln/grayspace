import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { APP_TITLE, CONTROL_PORT } from './config.ts'
import { getPreloadPath, IS_MAC } from './bootstrap.ts'
import { isLocalPath } from './media.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import type { AppState } from './appState.ts'

let mainWindow: BrowserWindow | null = null

// Browser guests are untrusted content. Only capabilities that do not expose
// device data or network surfaces are allowed without an explicit product flow.
// Electron's permission API is allow-by-callback, so unknown/new permissions
// must remain denied by default rather than being silently granted.
const ALLOWED_WEBVIEW_PERMISSIONS = new Set(['fullscreen', 'pointerLock'])

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function send(channel: string, ...args: unknown[]): void {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send(channel, ...args)
    }
  } catch (err) {
    // A renderer crash between the isDestroyed check and send must not take
    // down the main process (terminal batch flushes call this per frame).
    console.warn(`failed to send ${channel}`, err)
  }
}

export function publishPresence(state: AppState, writeFn: (payload: { workspaceDir: string | null }) => void): void {
  try {
    writeFn({ workspaceDir: state.workspaceDir ?? null })
  } catch (err) {
    console.error('failed to write runtime presence', err)
  }
}

export function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

export function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 560,
    show: false,
    ...(IS_MAC
      ? { titleBarStyle: 'hidden', trafficLightPosition: { x: 14, y: 13 } }
      : { frame: false }),
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    backgroundColor: '#08090b',
    title: APP_TITLE,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // Failsafe: guarantee window visibility even if Vite dev compilation delays initial paint
  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
    }
  }, 1200)
  win.once('show', () => clearTimeout(showTimer))

  // Forward renderer errors only (level 3 === error).
  // Supports both legacy (event, level, message, line, sourceId) and modern (event, details) signatures.
  win.webContents.on('console-message', (_event, ...args: unknown[]) => {
    let level = 0
    let message = ''
    let line = 0
    let sourceId = ''
    if (args.length === 1 && typeof args[0] === 'object' && args[0] !== null) {
      const details = args[0] as { level?: number; message?: string; lineNumber?: number; sourceId?: string }
      level = details.level ?? 0
      message = details.message ?? ''
      line = details.lineNumber ?? 0
      sourceId = details.sourceId ?? ''
    } else {
      level = Number(args[0]) || 0
      message = String(args[1] || '')
      line = Number(args[2]) || 0
      sourceId = String(args[3] || '')
    }
    if (level < 3) return
    console.error(`[Renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load window: ${errorCode} - ${errorDescription} (${validatedURL})`)
  })

  win.webContents.on('will-navigate', (e, url) => {
    // Only the app's own entry points may navigate the privileged window:
    // the dev server, the packaged control-server origin, or the exact
    // packaged index file. A suffix match lets any local .../index.html
    // (including a downloaded one) load with preload/IPC attached.
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const controlOrigin = `http://127.0.0.1:${CONTROL_PORT}/`
    let isAppUrl =
      Boolean(devUrl && (url.startsWith(devUrl) || url.startsWith('http://localhost:20222') || url.startsWith('http://127.0.0.1:20222'))) ||
      url.startsWith('orc://app') ||
      url === controlOrigin ||
      url.startsWith(controlOrigin)
    if (!isAppUrl) {
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'file:') {
          const expected = join(__dirname, '../renderer/index.html').replace(/\\/g, '/').toLowerCase()
          isAppUrl = decodeURIComponent(parsed.pathname).replace(/\\/g, '/').toLowerCase() === expected
        }
      } catch {
        isAppUrl = false
      }
    }
    if (!isAppUrl) {
      e.preventDefault()
      if (url.startsWith('https:') || url.startsWith('http:')) {
        import('electron').then(({ shell }) => shell.openExternal(url)).catch(() => {})
      }
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      import('electron').then(({ shell }) => shell.openExternal(url)).catch(() => {})
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    // Portless loading: orc://app provides a secure, valid origin for media providers
    // without requiring any local HTTP server or open TCP ports.
    win.loadURL('orc://app/index.html')
  }

  mainWindow = win
  return win
}

export function handleSecondInstanceArgs(
  argv: string[],
  deps: { state: AppState; send: (channel: string, ...args: unknown[]) => void; focus: () => void }
): void {
  deps.focus()
  const candidates = argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith('-') && !arg.includes('electron') && arg !== '.')
  for (const candidate of candidates) {
    try {
      if (!isLocalPath(candidate)) continue
      if (!fs.existsSync(candidate)) continue
      const stat = fs.statSync(candidate)
      const dir = stat.isDirectory() ? candidate : dirname(candidate)
      if (!fs.existsSync(dir)) continue
      deps.state.setWorkspaceDir(dir)
      syncOrcGuide(dir)
      deps.send('workspace:onDirChange', dir)
      return
    } catch {
      /* try next arg */
    }
  }
}

export function setupWebContentsHandlers(sendFn: (channel: string, ...args: unknown[]) => void): void {
  app.on('web-contents-created', (_event, contents) => {
    // Harden every <webview> guest at attach time (fires on the embedder):
    // strip any renderer-supplied preload and force a locked-down sandbox.
    contents.on('will-attach-webview', (e, webPreferences, params) => {
      delete (params as Record<string, unknown>).preload
      delete (params as Record<string, unknown>).preloadURL
      ;(webPreferences as Record<string, unknown>).nodeIntegration = false
      ;(webPreferences as Record<string, unknown>).contextIsolation = true
      ;(webPreferences as Record<string, unknown>).sandbox = true
      // webviewTag inside a guest would allow nesting untrusted guests.
      ;(webPreferences as Record<string, unknown>).webviewTag = false
      void e
    })

    if (contents.getType() !== 'webview') return

    let isDestroyed = false
    let lastOpenTime = 0
    let lastOpenUrl = ''

    contents.on('destroyed', () => {
      isDestroyed = true
    })

    contents.on('will-prevent-unload', (event) => {
      event.preventDefault()
    })

    // Guest top-level navigation guard: only http(s) may navigate the guest
    // (plus the blank initial document). javascript:/data:/file:/blob: and
    // anything else non-http(s) is denied — the embedder allowlists nothing.
    contents.on('will-navigate', (e, url) => {
      if (url === 'about:blank') return
      let ok = false
      try {
        const proto = new URL(url).protocol
        ok = proto === 'http:' || proto === 'https:'
      } catch {
        ok = false
      }
      if (!ok) e.preventDefault()
    })

    // Browser guests get no privileged capabilities. Keep this deny-by-default
    // because Electron may add permission names in future releases.
    try {
      contents.session.setPermissionRequestHandler((_webContents, permission, callback) => {
        callback(ALLOWED_WEBVIEW_PERMISSIONS.has(permission))
      })
    } catch {
      /* session may be torn down during shutdown */
    }

    contents.setWindowOpenHandler(({ url }) => {
      if (isDestroyed || contents.isDestroyed()) return { action: 'deny' }
      try {
        const parsed = new URL(url)
        if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
          const now = Date.now()
          if (now - lastOpenTime > 350 || lastOpenUrl !== url) {
            lastOpenTime = now
            lastOpenUrl = url
            sendFn('browser:onOpenTab', url)
          }
        }
      } catch {
        /* ignore */
      }
      return { action: 'deny' }
    })
  })
}
