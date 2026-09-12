import { app, BrowserWindow, dialog } from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { APP_TITLE, CONTROL_PORT } from './config.ts'
import { getPreloadPath, IS_MAC } from './bootstrap.ts'
import { isLocalPath } from './media.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import type { AppState } from './appState.ts'
import { isTrustedAppNavigation } from './navigationGuard.ts'
import { clearMountedTerminals, setFocusedTerminal } from './ipc/terminalFocus.ts'

let mainWindow: BrowserWindow | null = null





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
    backgroundColor: '#080808',
    title: APP_TITLE,
    webPreferences: {
      preload: getPreloadPath(),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: !app.isPackaged,
      webviewTag: true,
      spellcheck: false,
      backgroundThrottling: true
    }
  })

  win.once('ready-to-show', () => {
    win.show()
    win.focus()
  })

  // HTML fullscreen from embedded pages must not promote the whole app window.
  const onWebContentsEvent = win.webContents.on.bind(win.webContents) as unknown as (
    event: string,
    listener: (event: { preventDefault(): void }) => void
  ) => void
  onWebContentsEvent('enter-html-full-screen', (event) => event.preventDefault())
  onWebContentsEvent('leave-html-full-screen', (event) => event.preventDefault())


  const showTimer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) {
      win.show()
      win.focus()
    }
  }, 1200)
  win.once('show', () => clearTimeout(showTimer))
  let recoveryTimer: ReturnType<typeof setTimeout> | undefined
  let rendererCrashes: number[] = []
  win.on('closed', () => {
    clearTimeout(showTimer)
    clearTimeout(recoveryTimer)
    if (mainWindow === win) mainWindow = null
  })
  try {
    win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => {
      callback(false)
    })
  } catch {

  }



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
    if (details.reason === 'clean-exit' || win.isDestroyed()) return
    clearMountedTerminals()
    setFocusedTerminal(null)
    const now = Date.now()
    rendererCrashes = rendererCrashes.filter((at) => now - at < 60_000)
    if (rendererCrashes.length >= 2) {
      dialog.showErrorBox('OrcSpace display stopped',
        'The display crashed repeatedly. Terminal processes are still running. Restart OrcSpace to restore the interface.')
      return
    }
    rendererCrashes.push(now)
    clearTimeout(recoveryTimer)
    recoveryTimer = setTimeout(() => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.reload()
    }, 500)
  })

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load window: ${errorCode} - ${errorDescription} (${validatedURL})`)
  })

  win.webContents.on('will-navigate', (e, url) => {
    const devUrl = process.env['ELECTRON_RENDERER_URL']
    const controlOrigin = `http://127.0.0.1:${CONTROL_PORT}/`
    const rendererFile = join(__dirname, '../renderer/index.html')
    if (!isTrustedAppNavigation(url, { devUrl, controlOrigin, rendererFile })) {
      e.preventDefault()
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

    }
  }
}

export function setupWebContentsHandlers(sendFn: (channel: string, ...args: unknown[]) => void): void {
  app.on('web-contents-created', (_event, contents) => {


    contents.on('will-attach-webview', (e, webPreferences, params) => {
      delete (params as Record<string, unknown>).preload
      delete (params as Record<string, unknown>).preloadURL
      ;(webPreferences as Record<string, unknown>).nodeIntegration = false
      ;(webPreferences as Record<string, unknown>).contextIsolation = true
      ;(webPreferences as Record<string, unknown>).sandbox = true

      ;(webPreferences as Record<string, unknown>).webviewTag = false
      try {
        const src = String((params as Record<string, unknown>).src ?? '')
        if (!src) return
        const proto = new URL(src).protocol
        if (proto !== 'http:' && proto !== 'https:' && src !== 'about:blank') e.preventDefault()
      } catch {
        e.preventDefault()
      }
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



    try {
      const sess = contents.session
      if (!(sess as unknown as { __orcPermGuard?: boolean }).__orcPermGuard) {
        ;(sess as unknown as { __orcPermGuard?: boolean }).__orcPermGuard = true
        sess.setPermissionRequestHandler((_webContents, permission, callback) => {
          callback(ALLOWED_WEBVIEW_PERMISSIONS.has(permission as string))
        })
      }
    } catch {

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

      }
      return { action: 'deny' }
    })
  })
}
