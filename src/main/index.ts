// Loaded before every other import: `config.ts` and others read `process.env`
// at import time, so this has to run first or a `.env` value would arrive one
// tick too late for them to see it.
import { config as loadEnvFile } from 'dotenv'
loadEnvFile()

import { app, shell, BrowserWindow, Menu } from 'electron'
import * as fs from 'fs'
import { dirname, join } from 'path'
import { pathToFileURL } from 'url'
import { APP_TITLE } from './config'
import { CoordinationStore } from './coordination'
import { TerminalManager } from './terminals'
import { TerminalStreamBatcher } from './terminalBatcher'
import { startControlServer } from './controlServer'
import { isMcpRunning, mcpStatus, restartMcpServer, startMcpServer, stopMcpServer } from './mcpProcess'
import { clearRuntimePresence, writeRuntimePresence } from './runtimePresence'
import { registerIpc, focusedTerminalId, originTerminalId, forgetTerminalOrigin, USER_ACTOR_ID, isTerminalMounted, clearMountedTerminals } from './ipc'
import { BrainStore } from './brain'
import { AppState } from './appState'
import { CanvasStore } from './canvasState'
import { PlannerStore } from './plannerStore.ts'
import { ensureCodexGlobalConfig, syncClineConfig, syncGlobalAntigravityConfig, syncGlobalWindsurfConfig, syncKimiConfig, syncProjectAntigravityConfig, syncProjectCursorConfig, syncProjectGrokConfig, syncProjectMcpConfig, syncProjectOpencodeConfig } from './mcpAutoConfig'
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

/**
 * Best-effort config syncs must never reject out of the startup path — a
 * failure to touch a config file on disk is a log line, not an unhandled
 * promise rejection.
 */
function fire(promise: Promise<void>): void {
  void promise.catch((err) => console.error('config sync failed', err))
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

const terminals = new TerminalManager()
// A build log or an agent streaming tokens can emit hundreds of pty chunks a
// second; forwarding each straight over IPC starves the renderer's event
// loop faster than it can paint. Consolidate into at most one IPC message
// per animation frame instead (PERF-terminal-ipc).
const terminalBatcher = new TerminalStreamBatcher()
/** cwd + title + capped scrollback per terminal, so a restart keeps the context. */
const snapshots = new TerminalSnapshots()
const coordination = new CoordinationStore(core.locks, (id) => core.actors.isAlive(id))
/** Persisted folders + settings; the brain reads the link syntax from here. */
const state = new AppState()
const brain = new BrainStore(() => state.settings.linkSyntax)
/** Canvas layout (widgets, camera, strokes) survives restarts — DI-004. */
const canvas = new CanvasStore()
/** The planner's outline — a day plan distinct from the delegable task board. */
const planner = new PlannerStore()

/**
 * The app owns two fixed loopback ports and one state file. A second copy would
 * fight the first for all three, so the second launch hands its arguments to the
 * running instance and exits instead.
 */
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  // exit(), not quit(): the loser has never loaded stores, and before-quit
  // flush() would write empty planner/board/canvas over the live instance.
  // Log so a `npm run dev` that immediately exits isn't a mystery — setup.bat
  // checks :20220 aliveness first, but a manual launch benefits from the hint.
  console.log('Another OrcSpace instance is already running — handing off and exiting.')
  app.exit(0)
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
}

function publishPresence(): void {
  try {
    writeRuntimePresence({
      mcpRunning: isMcpRunning(),
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
      preload: join(__dirname, '../preload/index.js'),
      // Chromium sandbox + context isolation: the renderer is untrusted-ish
      // input surface (note content from agents), so both are on. The preload
      // only uses contextBridge/ipcRenderer, which work sandboxed (SEC-005).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      // The Browser pane hosts real web pages in <webview> guests. They render
      // in their own processes with their own preferences, pinned below by
      // `will-attach-webview`, so the app renderer keeps its own hardening.
      webviewTag: true
    }
  })

  mainWindow.show()
  mainWindow.focus()

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
  mainWindow.webContents.on('did-finish-load', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show()
      mainWindow.focus()
    }
  })
  mainWindow.on('maximize', () => send('window:onMaximizeChange', true))
  mainWindow.on('unmaximize', () => send('window:onMaximizeChange', false))
  // Without this the reference outlives the window and every later `send`
  // reaches into a destroyed web contents.
  mainWindow.on('closed', () => {
    mainWindow = null
  })
  // Only well-known web/mail links reach the system handler — a window.open
  // that sneaks in `file:` or a custom protocol must not (SEC-009).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') {
        // No handler for the scheme (or a policy block) rejects the promise.
        shell.openExternal(url).catch((err) => {
          console.warn('failed to open external url', url, err)
        })
      }
    } catch {
      /* an unparsable url is not worth opening */
    }
    return { action: 'deny' }
  })
  const allowRendererNavigation = (url: string): boolean => {
    if (process.env['ELECTRON_RENDERER_URL']) {
      try {
        return new URL(url).origin === new URL(process.env['ELECTRON_RENDERER_URL']).origin
      } catch {
        return false
      }
    }
    return url === pathToFileURL(join(__dirname, '../renderer/index.html')).href
  }
  const guardNavigation = (event: Electron.Event, url: string): void => {
    if (allowRendererNavigation(url)) return
    event.preventDefault()
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'https:' || protocol === 'http:' || protocol === 'mailto:') void shell.openExternal(url)
    } catch {
      /* malformed and privileged schemes stay blocked */
    }
  }
  mainWindow.webContents.on('will-navigate', guardNavigation)
  mainWindow.webContents.on('will-redirect', guardNavigation)

  // A <webview> shows pages nobody vetted, so its privileges are decided here
  // and not read from whatever attributes the renderer happened to set: no
  // preload, no node, sandbox and web security on (SEC-005).
  mainWindow.webContents.on('will-attach-webview', (_event, webPreferences, params) => {
    delete webPreferences.preload
    webPreferences.nodeIntegration = false
    webPreferences.nodeIntegrationInSubFrames = false
    webPreferences.contextIsolation = true
    webPreferences.sandbox = true
    webPreferences.webSecurity = true
    // Guests live in the browser pane's own partition — never the app session,
    // whose cookies belong to the workspace's own services.
    params.partition = BROWSER_PARTITION
  })

  // The application menu's edit accelerators (Ctrl+C/X/A/Z) win over the
  // page's keydown on Windows/Linux — but inside a terminal those keys mean
  // SIGINT / begin-of-line / suspend, not copy/cut/undo. While a terminal
  // widget has focus they are intercepted here and written to its pty instead;
  // the menu keeps its normal behaviour everywhere else. Ctrl+V is left alone:
  // the paste accelerator lands in xterm's textarea, whose paste event is
  // already owned by the widget.
  //
  // macOS is exempt: there the edit accelerators are Cmd-based, so Ctrl+C never
  // collides with them and xterm already writes \x03 itself. Intercepting here
  // as well would send SIGINT twice for a single keystroke.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (IS_MAC) return
    const focusedId = focusedTerminalId()
    if (focusedId && input.type === 'keyDown' && input.control && !input.alt && !input.meta) {
      const signal = { c: '\x03', a: '\x01', z: '\x1a', x: '\x18' }[input.key.toLowerCase()]
      if (signal) {
        event.preventDefault()
        // Through the bus, like every other keystroke, so an agent holding the
        // terminal's lock keeps SIGINT from interleaving with its command (P4).
        void core.bus.submit({
          actorId: USER_ACTOR_ID,
          type: 'terminal.input',
          target: `terminal:${focusedId}`,
          payload: { data: signal }
        }).catch(() => {
          // Keystroke lost to queue backpressure is better than an unhandled
          // rejection from the input event handler.
        })
      }
    }
  })

  // Keep PTYs across a renderer crash/reload so Claude Code and other long
  // sessions reconnect when the window comes back. They are still torn down
  // on app quit (before-quit / window-all-closed).
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('renderer process gone', details.reason, details.exitCode)
    clearMountedTerminals()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL']).catch((err) => {
      // A failed load otherwise dies as a silent unhandled rejection and the
      // window stays blank with no trace of why.
      console.error('failed to load the renderer URL', err)
    })
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html')).catch((err) => {
      console.error('failed to load the built renderer', err)
    })
  }
}

// Pipe terminal and coordination activity to the renderer so widgets and the
// kanban board stay in sync with whatever agents are doing over MCP. Output is
// only forwarded for terminals whose widget is actually mounted — a detached
// shell (workspace switch, renderer gone) must not flood the window with bytes
// nothing is rendering (P7).
terminals.on('data', (id: string, chunk: string) => {
  terminalBatcher.push(id, chunk)
})
terminalBatcher.on('batch', (id: string, chunk: string) => {
  if (isTerminalMounted(id)) send('terminal:onData', id, chunk)
})
terminals.on('exit', (id: string, code: number) => {
  // Flush first: a batch still sitting in the 16ms window would otherwise be
  // able to arrive after (and render below) the exit notice below it.
  terminalBatcher.flush(id)
  send('terminal:onExit', id, code)
})
// Persist scrollback whenever a shell is actually torn down (app quit, explicit
// close). Folder switches no longer release — those reconnect to the live pty.
// Async: this fires on every terminal the user closes, interactively, so it
// must not block the window on a disk write (see TerminalSnapshots.saveAsync).
// The quit path saves durably and synchronously instead — see snapshotTerminals.
terminals.on(
  'release',
  (info: { id: string; title: string; cwd: string; scrollback: string }) => {
    // before-quit has already saved every live terminal durably by the time
    // disposeAll() fires these releases — a second save here would truncate
    // the just-written scrollback asynchronously during teardown.
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
// MCP/assistant canvas commands are applied in the main process. Broadcast the
// resulting snapshot so a rename or move is visible immediately in the open
// renderer instead of only after the next restart.
canvas.on('change', (snapshot) => send('canvas:onChange', snapshot))

/**
 * Point every supported AI agent at this workspace's MCP server, in one call.
 *
 * The three places that open a workspace (startup, the folder picker, a second
 * launch carrying a path) each used to inline their own list of syncs, and the
 * lists had already drifted: the second-launch path never registered
 * Antigravity, so opening a folder from a shortcut left that one agent unable
 * to see the workspace while the other paths wired it up fine. One function
 * means adding an agent is a single edit and no caller can fall behind again.
 */
function syncAgentConfigsFor(dir: string): void {
  // Per-project: these agents read their config from the folder they run in.
  fire(syncProjectMcpConfig(dir))
  fire(syncProjectOpencodeConfig(dir))
  fire(syncProjectGrokConfig(dir))
  fire(syncProjectCursorConfig(dir))
  fire(syncProjectAntigravityConfig(dir))
  fire(syncKimiConfig(dir))
  syncGlobalAgentConfigs()
}

/**
 * The agents that keep a single config file rather than a per-project one.
 * Split out because these still have to be written when no folder is open at
 * all — otherwise a first run with no workspace leaves them unconfigured until
 * the user happens to pick a folder.
 */
function syncGlobalAgentConfigs(): void {
  fire(syncGlobalWindsurfConfig())
  fire(syncGlobalAntigravityConfig())
  fire(syncClineConfig())
  fire(ensureCodexGlobalConfig())
}

/**
 * A second launch may carry a folder path (shortcut, file association, or
 * `OrcSpace.exe C:\project`). Open it in the running instance instead of
 * dropping the argv on the floor.
 */
function handleSecondInstanceArgs(argv: string[]): void {
  focusMainWindow()
  // Electron's own switches and the exe path sit first; real paths are later.
  const candidates = argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith('-') && !arg.includes('electron') && arg !== '.')
  for (const candidate of candidates) {
    try {
      // Same UNC guard as workspace:open-recent — existsSync on a network
      // path would make the main process initiate an SMB connection.
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
      /* try the next arg */
    }
  }
}

if (hasInstanceLock) {
  app.on('second-instance', (_event, argv) => handleSecondInstanceArgs(argv))

  app.whenReady().then(() => {
    if (process.platform === 'win32') {
      app.setAppUserModelId('com.orcspace.app')
    }
    // On Windows/Linux, Ctrl+C/V/X/A/Z are wired through the application menu's
    // accelerators, not raw keydown handling — with no Menu at all (this window
    // is frame:false and never shows one), those keys reach focused text areas
    // as literal keystrokes instead of triggering the native paste/copy/cut.
    // `editMenu` registers the accelerators without ever rendering a menu bar.
    //
    // macOS always renders the menu bar, and it needs the real thing: without an
    // app menu first, Cmd+Q / Cmd+H / About are simply missing, and macOS would
    // promote whatever menu comes first into that slot. Window and View give
    // back Cmd+M / Cmd+W / fullscreen, which a frameless window has no other
    // affordance for.
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

    // Codex, Windsurf, Cline and Antigravity each have one global config file —
    // register the workspace server there whether or not a folder is open, so
    // any `codex` run anywhere already sees it.
    // Claude Code, by contrast, reads `.mcp.json` from its cwd, so the
    // equivalent for it is per-project: whichever folder is open at startup.
    // opencode reads its own `opencode.json` from the cwd the same way.
    if (state.workspaceDir) syncAgentConfigsFor(state.workspaceDir)
    else syncGlobalAgentConfigs()

    // Keep the rail's folder list live whenever the persisted state moves.
    state.on('change', (next) => {
      send('workspace:onRecentChange', next.recent)
      send('settings:onChange', state.publicSettings())
      publishPresence()
    })
    brain.on('change', (snapshot) => send('brain:onChange', snapshot))

    // Handlers first: a transport that submits a command before its handler
    // exists gets `unknown_command`, and the window is created below.
    registerCommands({
      core,
      canvas,
      brain,
      board: coordination,
      planner,
      terminals,
      snapshots,
      requestWidget: (info) => send('control:add-widget', info),
      requestWidgetRemoval: (id) => send('control:remove-widget', id),
      originWidgetId: originTerminalId,
      forgetOrigin: forgetTerminalOrigin,
      defaultCwd: () => state.workspaceDir
    })

    registerIpc({
      core,
      terminals,
      coordination,
      planner,
      brain,
      canvas,
      state,
      getWindow: () => mainWindow,
      getWorkspaceDir: () => state.workspaceDir,
      setWorkspaceDir: (dir) => {
        const previous = state.workspaceDir
        state.setWorkspaceDir(dir)
        if ((dir || undefined) === previous) return
        // A terminal opened right after picking a folder should already see the
        // workspace's MCP tools, not just ones opened on a later restart.
        if (dir) syncAgentConfigsFor(dir)
        send('workspace:onDirChange', dir ?? null)
      }
    })

    createWindow()


    controlServer = startControlServer({
      core,
      terminals,
      coordination,
      planner,
      brain,
      canvas,
      state,
      defaultCwd: () => state.workspaceDir,
      mcpRunning: isMcpRunning,
      mcpStatus,
      restartMcp: restartMcpServer
    })

    publishPresence()

    startMcpServer((status) => {
      send('mcp:onStatusChange', status)
      publishPresence()
    })

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusMainWindow()
    })
  })
  .catch((err) => {
    // Every startup step above is individually best-effort, but a synchronous
    // throw anywhere in the chain would otherwise surface only as an unhandled
    // rejection: no window, servers half-up, and nothing in the log.
    console.error('app startup failed', err)
  })
}

// `target="_blank"` and `window.open` inside a browser tab become another tab in
// the pane instead of a real popup window: the pane keeps every page inside the
// hardened guest preferences above, and a page cannot spawn bare chrome.
app.on('web-contents-created', (_event, contents) => {
  if (contents.getType() !== 'webview') return
  contents.setWindowOpenHandler(({ url }) => {
    try {
      const protocol = new URL(url).protocol
      if (protocol === 'https:' || protocol === 'http:') send('browser:onOpenTab', url)
    } catch {
      /* an unparsable url is not worth a tab */
    }
    return { action: 'deny' }
  })
})

app.on('window-all-closed', () => {
  // macOS apps conventionally stay resident with no windows; every other
  // platform expects closing the last window to end the process.
  // Cleanup lives only in `before-quit`: disposing PTYs here first made
  // snapshotTerminals() see an empty list and prune every saved scrollback.
  if (process.platform === 'darwin') return
  app.quit()
})

/**
 * Saves what every live terminal had on screen, and drops snapshots for ones
 * no widget refers to any more. Must run while PTYs are still listed — after
 * disposeAll the live set is empty and prune() would wipe every saved screen.
 */
function snapshotTerminals(): void {
  const live = new Set<string>()
  for (const info of terminals.list()) {
    live.add(info.id)
    // Durable: the process is about to be torn down, so this has to block
    // until the bytes are actually on disk rather than racing Electron's exit.
    snapshots.save({
      id: info.id,
      title: info.title,
      cwd: info.cwd,
      scrollback: terminals.fullOutput(info.id) ?? ''
    })
  }
  snapshots.prune(live)
  // prune()'s forget() calls debounce the index rewrite; force it out now so
  // a stale snapshot's removal isn't lost to the app actually quitting first.
  snapshots.flushNow()
}

let shuttingDown = false

app.on('before-quit', () => {
  if (shuttingDown) return
  shuttingDown = true
  snapshotTerminals()
  // disposeAll() below re-emits `release` per terminal; saveAsync must not
  // re-truncate what snapshotTerminals() just wrote.
  snapshots.beginShutdown()
  try {
    controlServer?.close()
  } catch {
    /* already closed */
  }
  controlServer = null
  clearRuntimePresence()
  terminals.disposeAll()
  stopMcpServer()
  // Debounced stores (PERF-004/005): whatever was pending must reach disk
  // before the process dies.
  brain.dispose()
  coordination.dispose()
  planner.dispose()
  canvas.dispose()
  core.dispose()
})

// Graceful shutdown on OS signals: go through app.quit() so before-quit
// snapshots live PTYs, flushes stores, then tears them down. Emitting
// before-quit alone used to leave Electron running with dead shells.
process.on('SIGINT', () => {
  app.quit()
})
process.on('SIGTERM', () => {
  app.quit()
})
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason)
  // Do not throw – crashing the process would lose the journal and snapshots.
})
// A synchronous throw inside an Electron event handler (before-input-event,
// web-contents-created, a pty callback) would otherwise take the whole main
// process down. Same policy as unhandledRejection: log it, stay alive — the
// failing operation's own caller is where recovery belongs, and quitting here
// would lose the journal and snapshots before-quit has not written yet.
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err)
})
