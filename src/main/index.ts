// Loaded before every other import: `config.ts` and others read `process.env`
// at import time, so this has to run first or a `.env` value would arrive one
// tick too late for them to see it.
import { config as loadEnvFile } from 'dotenv'
loadEnvFile()

import { app, BrowserWindow, Menu } from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { APP_TITLE, CONTROL_PORT } from './config'
import { CoordinationStore } from './coordination'
import { TerminalManager } from './terminals'
import { TerminalStreamBatcher } from './terminalBatcher'
import { startControlServer } from './controlServer'
import { OrchestrationStore } from './orchestration/store.ts'
import { ensureOrcExecutable } from './orcCli.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import { clearRuntimePresence, writeRuntimePresence } from './runtimePresence'
import { registerIpc, focusedTerminalId, originTerminalId, forgetTerminalOrigin, USER_ACTOR_ID, isTerminalMounted, clearMountedTerminals } from './ipc'
import { AppState } from './appState'
import { CanvasStore } from './canvasState'
import { CodeStore } from './codeState.ts'
import { PlannerStore } from './plannerStore.ts'
import { initPlannerSync } from './plannerSync.ts'
import { createCore } from './core/index.ts'
import { FileJournalSink, readJournalTail } from './journalSink'
import { registerCommands } from './commands/index.ts'
import { TerminalSnapshots } from './terminalSnapshots'
import { isLocalPath } from './media.ts'
import { join as joinPath } from 'path'

/**
 * Session the Browser pane's tabs share. Persistent so logins survive a
 * restart, and separate from the app session so a visited page can never read
 * the workspace's own cookies.
 */
const BROWSER_PARTITION = 'persist:orcspace-browser'

/** macOS differs on menus, accelerators and window chrome — checked in all three. */
const IS_MAC = process.platform === 'darwin'

let mainWindow: BrowserWindow | null = null
let controlServer: { close(): void } | null = null
let orchestrationSignal: ReturnType<typeof setTimeout> | null = null

function getPreloadPath(): string {
  const candidates = [
    join(__dirname, '../preload/index.cjs'),
    join(__dirname, '../preload/index.js'),
    join(__dirname, '../preload/index.mjs')
  ]
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate
  }
  return join(__dirname, '../preload/index.cjs')
}

/**
 * The unified core, built before anything that writes state exists. Every
 * store below is mutated only by the command handlers registered on its bus,
 * and every transport below only translates requests into commands.
 */
const journalFile = joinPath(app.getPath('userData'), 'command-journal.ndjson')
const journalTail = readJournalTail(journalFile)
const core = createCore({
  sink: new FileJournalSink({ file: journalFile }),
  startSeq: journalTail.lastSeq,
  seed: journalTail.entries
})

/** Persisted folders + settings. */
const state = new AppState()
const terminals = new TerminalManager({ getWindowsShell: () => state.settings.windowsShell })
// A build log or an agent streaming tokens can emit hundreds of pty chunks a
// second; forwarding each straight over IPC starves the renderer's event
// loop faster than it can paint. Consolidate into at most one IPC message
// per animation frame instead (PERF-terminal-ipc).
const terminalBatcher = new TerminalStreamBatcher()
/** cwd + title + capped scrollback per terminal, so a restart keeps the context. */
const snapshots = new TerminalSnapshots()
const coordination = new CoordinationStore(core.locks, (id) => core.actors.isAlive(id))
/** Canvas layout (widgets, camera, strokes) survives restarts — DI-004. */
const canvas = new CanvasStore()
/** Code tab sessions survive restarts per-workspace. */
const code = new CodeStore()
/** The planner's outline — a day plan distinct from the delegable task board. */
const planner = new PlannerStore()
/**
 * Runs, delegated tasks, dispatches and the coordinator inbox — the native
 * coordination layer agents drive through the `orc` CLI instead of a protocol.
 */
const orchestration = new OrchestrationStore()

/** Bidirectional live sync between personal day planner and coordination board. */
const disposePlannerSync = initPlannerSync(planner, coordination)

/**
 * The app owns two fixed loopback ports and one state file. A second copy would
 * fight the first for all three, so the second launch hands its arguments to the
 * running instance and exits instead.
 */
// Allow ambient media, music widgets, and alert sounds to play without requiring an initial user gesture.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
// Use Direct3D 11 ANGLE backend on Windows for smooth 60+ FPS hardware acceleration
if (process.platform === 'win32') {
  app.commandLine.appendSwitch('use-angle', 'd3d11')
  app.commandLine.appendSwitch('enable-gpu-rasterization')
  app.commandLine.appendSwitch('enable-zero-copy')
  app.commandLine.appendSwitch('ignore-gpu-blocklist')
}

const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  // exit(), not quit(): the loser has never loaded stores, and before-quit
  // flush() would write empty planner/board/canvas over the live instance.
  // Log so a `npm run dev` that immediately exits isn't a mystery — setup.bat
  // checks :20220 aliveness first, but a manual launch benefits from the hint.
  console.warn('Another OrcSpace instance is already running — handing off and exiting.')
  app.exit(0)
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function publishPresence(): void {
  try {
    writeRuntimePresence({
      workspaceDir: state.workspaceDir ?? null
    })
  } catch (err) {
    console.error('failed to write runtime presence', err)
  }
}

function focusMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 800,
    minHeight: 560,
    show: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: false,
    // macOS keeps its traffic lights on a frameless window: park them where the
    // custom title bar leaves room, so they never sit on top of its controls.
    ...(IS_MAC ? { trafficLightPosition: { x: 14, y: 13 } } : {}),
    autoHideMenuBar: true,
    transparent: false,
    hasShadow: true,
    backgroundColor: '#0e0e11',
    title: APP_TITLE,
    webPreferences: {
      preload: getPreloadPath(),
      // Chromium sandbox + context isolation: the renderer is untrusted-ish
      // input surface (note content from agents), so both are on. The preload
      // only uses contextBridge/ipcRenderer, which work sandboxed (SEC-005).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      spellcheck: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    console.log(`[Renderer:${level}] ${message} (${sourceId}:${line})`)
  })

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Renderer process gone:', details)
  })

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`Failed to load window: ${errorCode} - ${errorDescription} (${validatedURL})`)
  })

  // Prevent arbitrary navigation in the main window
  mainWindow.webContents.on('will-navigate', (e, url) => {
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

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) {
      import('electron').then(({ shell }) => shell.openExternal(url)).catch(() => {})
    }
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Forward raw keyboard shortcuts directly to the focused xterm.js instance
// rather than letting the renderer swallow them.
app.on('browser-window-created', (_, window) => {
  window.webContents.on('before-input-event', (event, input) => {
    // Only intercept if this input is a key down and not an IME composition
    if (input.type !== 'keyDown' || input.isComposing) return

    const termId = focusedTerminalId()
    if (termId && isTerminalMounted(termId)) {
      // If terminal is focused, special keys (like Ctrl+C / SIGINT) should route directly to pty
      if (input.control && input.key.toLowerCase() === 'c') {
        event.preventDefault()
        terminals.write(termId, '\x03')
        return
      }
    }

    // Allow native copy/paste/cut/undo shortcuts to proceed to the edit menu
    const isControlOrMeta = process.platform === 'darwin' ? input.meta : input.control
    if (isControlOrMeta && ['c', 'v', 'x', 'z', 'a', 'r', 'w'].includes(input.key.toLowerCase())) {
      // Cmd+W on macOS or Ctrl+W: do not steal window close / standard edit commands
      return
    }
  })
})

// Pipe terminal and coordination activity to the renderer so widgets and the
// kanban board stay in sync with whatever agents are doing.
terminals.on('data', (id: string, chunk: string) => {
  terminalBatcher.push(id, chunk)
})
terminalBatcher.on('batch', (id: string, chunk: string) => {
  if (isTerminalMounted(id)) send('terminal:onData', id, chunk)
})
terminals.on('exit', (id: string, code: number) => {
  terminalBatcher.flush(id)
  send('terminal:onExit', id, code)
})
terminals.on(
  'release',
  (info: { id: string; title: string; cwd: string; scrollback: string }) => {
    if (shuttingDown) return
    snapshots.saveAsync({
      id: info.id,
      title: info.title,
      cwd: info.cwd,
      scrollback: info.scrollback
    })
  }
)
coordination.on('change', (snapshot) => {
  send('coordination:onChange', snapshot)
})
planner.on('change', (items) => send('planner:onChange', items))
canvas.on('change', (snapshot) => send('canvas:onChange', snapshot))
code.on('change', (snapshot) => send('code:onChange', snapshot))

function syncAgentConfigsFor(dir: string): void {
  syncOrcGuide(dir)
}

function handleSecondInstanceArgs(argv: string[]): void {
  focusMainWindow()
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
      state.setWorkspaceDir(dir)
      syncAgentConfigsFor(dir)
      send('workspace:onDirChange', dir)
      return
    } catch {
      /* try next arg */
    }
  }
}

if (hasInstanceLock) {
  app.on('second-instance', (_event, argv) => handleSecondInstanceArgs(argv))

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.orcspace.app')
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate(
        IS_MAC
          ? [
              { role: 'appMenu' },
              { role: 'editMenu' },
              {
                label: 'View',
                submenu: [
                  { role: 'reload' },
                  { role: 'forceReload' },
                  { role: 'toggleDevTools' },
                  { type: 'separator' },
                  { role: 'resetZoom' },
                  { role: 'zoomIn' },
                  { role: 'zoomOut' },
                  { type: 'separator' },
                  { role: 'togglefullscreen' }
                ]
              },
              { role: 'windowMenu' }
            ]
          : [{ role: 'editMenu' }]
      )
    )

    if (state.workspaceDir) syncAgentConfigsFor(state.workspaceDir)

    state.on('change', (next) => {
      send('workspace:onRecentChange', next.recent)
      send('settings:onChange', state.publicSettings())
      publishPresence()
    })

    let orchestrationSignal: ReturnType<typeof setTimeout> | null = null
    orchestration.on('changed', () => {
      if (orchestrationSignal !== null) return
      orchestrationSignal = setTimeout(() => {
        orchestrationSignal = null
        send('orchestration:onChange')
      }, 100)
      orchestrationSignal.unref?.()
    })

    registerCommands({
      core,
      canvas,
      board: coordination,
      planner,
      orchestration,
      terminals,
      snapshots,
      requestWidget: (info) => send('control:add-widget', info),
      requestWidgetRemoval: (id) => send('control:remove-widget', id),
      requestWidgetRename: (id, title) => send('control:rename-widget', { id, title }),
      originWidgetId: originTerminalId,
      forgetOrigin: forgetTerminalOrigin,
      defaultCwd: () => state.workspaceDir
    })

    registerIpc({
      core,
      terminals,
      coordination,
      planner,
      orchestration,
      canvas,
      code,
      state,
      getWindow: () => mainWindow,
      getWorkspaceDir: () => state.workspaceDir,
      setWorkspaceDir: (dir) => {
        const previous = state.workspaceDir
        state.setWorkspaceDir(dir)
        if ((dir || undefined) === previous) return
        if (dir) syncAgentConfigsFor(dir)
        send('workspace:onDirChange', dir ?? null)
      }
    })

    ensureOrcExecutable()

    createWindow()

    controlServer = startControlServer({
      core,
      terminals,
      coordination,
      planner,
      orchestration,
      canvas,
      state,
      defaultCwd: () => state.workspaceDir,
      broadcast: (channel, payload) => send(channel, payload)
    })

    publishPresence()
    initAutoUpdater()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusMainWindow()
    })
  })
  .catch((err) => {
    console.error('app startup failed', err)
  })
}

function initAutoUpdater(): void {
  if (!app.isPackaged) return
  import('electron-updater')
    .then(({ autoUpdater }) => {
      autoUpdater.logger = console
      autoUpdater.autoDownload = true
      autoUpdater.autoInstallOnAppQuit = true
      autoUpdater.checkForUpdatesAndNotify().catch((err: unknown) => {
        console.warn('Auto-updater check failed:', err)
      })
    })
    .catch(() => {})
}

app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return

  let isDestroyed = false
  let lastOpenTime = 0
  let lastOpenUrl = ''

  contents.on('destroyed', () => {
    isDestroyed = true
  })

  // Prevent web pages from trapping navigation or blocking tab close with beforeunload prompts
  contents.on('will-prevent-unload', (event) => {
    event.preventDefault()
  })

  contents.setWindowOpenHandler(({ url }) => {
    if (isDestroyed || contents.isDestroyed()) return { action: 'deny' }
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        const now = Date.now()
        // Prevent popup cascades and rapid duplicate triggers (throttle to 1 per 350ms)
        if (now - lastOpenTime > 350 || lastOpenUrl !== url) {
          lastOpenTime = now
          lastOpenUrl = url
          send('browser:onOpenTab', url)
        }
      }
    } catch {
      /* ignore */
    }
    return { action: 'deny' }
  })
})

app.on('window-all-closed', () => {
  if (process.platform === 'darwin') return
  app.quit()
})

function snapshotTerminals(): void {
  const live = new Set<string>()
  for (const info of terminals.list()) {
    live.add(info.id)
    snapshots.save({
      id: info.id,
      title: info.title,
      cwd: info.cwd,
      scrollback: terminals.fullOutput(info.id) ?? ''
    })
  }
  snapshots.prune(live)
  snapshots.flushNow()
}

let shuttingDown = false

app.on('before-quit', () => {
  if (shuttingDown) return
  shuttingDown = true
  if (orchestrationSignal !== null) { clearTimeout(orchestrationSignal); orchestrationSignal = null }
  snapshotTerminals()
  snapshots.beginShutdown()
  try {
    controlServer?.close()
  } catch {
    /* already closed */
  }
  controlServer = null
  clearRuntimePresence()
  terminals.disposeAll()
  disposePlannerSync()
  coordination.dispose()
  planner.dispose()
  orchestration.dispose()
  canvas.dispose()
  code.dispose()
  core.dispose()
})

process.on('SIGINT', () => {
  app.quit()
})
process.on('SIGTERM', () => {
  app.quit()
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason)
})
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})
