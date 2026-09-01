import { app, BrowserWindow } from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { APP_TITLE } from './config'
import { getPreloadPath, IS_MAC } from './bootstrap.ts'
import { isLocalPath } from './media.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import type { AppState } from './appState.ts'

let mainWindow: BrowserWindow | null = null

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win
}

export function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
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
    minWidth: 800,
    minHeight: 560,
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    ...(IS_MAC ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    backgroundColor: '#0e0e11',
    title: APP_TITLE,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  win.on('ready-to-show', () => {
    win.show()
    win.focus()
  })

  win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  win.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load window: ${errorCode} - ${errorDescription} (${validatedURL})`)
  })

  win.webContents.on('will-navigate', (e, url) => {
    const isAppUrl =
      (process.env['ELECTRON_RENDERER_URL'] && url.startsWith(process.env['ELECTRON_RENDERER_URL'])) ||
      url.endsWith('index.html') ||
      url.startsWith('file://')
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
    win.loadFile(join(__dirname, '../renderer/index.html'))
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
