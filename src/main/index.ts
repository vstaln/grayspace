import { app, shell, BrowserWindow, Menu } from 'electron'
import { join } from 'path'
import { APP_TITLE } from './config'
import { CoordinationStore } from './coordination'
import { TerminalManager } from './terminals'
import { startControlServer } from './controlServer'
import { isMcpRunning, startMcpServer, stopMcpServer } from './mcpProcess'
import { registerIpc, focusedTerminalId } from './ipc'
import { BrainStore } from './brain'
import { AppState } from './appState'
import { CanvasStore } from './canvasState'
import { ensureCodexGlobalConfig, syncProjectMcpConfig, syncProjectOpencodeConfig } from './mcpAutoConfig'
import { createCore } from './core/index.ts'
import { FileJournalSink, readJournalTail } from './journalSink'
import { registerCommands } from './commands/index.ts'
import { join as joinPath } from 'path'

let mainWindow: BrowserWindow | null = null

/**
 * The unified core, built before anything that writes state exists. Every
 * store below is mutated only by the command handlers registered on its bus,
 * and every transport below only translates requests into commands.
 */
const journalFile = joinPath(app.getPath('userData'), 'command-journal.ndjson')
const core = createCore({
  sink: new FileJournalSink({ file: journalFile }),
  startSeq: readJournalTail(journalFile, 1).lastSeq
})

const terminals = new TerminalManager()
const coordination = new CoordinationStore(core.locks)
/** Persisted folders + settings; the brain reads the link syntax from here. */
const state = new AppState()
const brain = new BrainStore(() => state.settings.linkSyntax)
/** Canvas layout (widgets, camera, strokes) survives restarts — DI-004. */
const canvas = new CanvasStore()

/**
 * The app owns two fixed loopback ports and one state file. A second copy would
 * fight the first for all three, so the second launch hands its arguments to the
 * running instance and exits instead.
 */
const hasInstanceLock = app.requestSingleInstanceLock()
if (!hasInstanceLock) {
  app.quit()
}

function send(channel: string, ...args: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...args)
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
    show: false,
    // The renderer owns the title bar; glass mode uses the native transparent
    // surface so the desktop can show through without a blur filter.
    frame: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: APP_TITLE,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // Chromium sandbox + context isolation: the renderer is untrusted-ish
      // input surface (note content from agents), so both are on. The preload
      // only uses contextBridge/ipcRenderer, which work sandboxed (SEC-005).
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow?.show())
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
        void shell.openExternal(url)
      }
    } catch {
      /* an unparsable url is not worth opening */
    }
    return { action: 'deny' }
  })

  // The application menu's edit accelerators (Ctrl+C/X/A/Z) win over the
  // page's keydown on Windows/Linux — but inside a terminal those keys mean
  // SIGINT / begin-of-line / suspend, not copy/cut/undo. While a terminal
  // widget has focus they are intercepted here and written to its pty instead;
  // the menu keeps its normal behaviour everywhere else. Ctrl+V is left alone:
  // the paste accelerator lands in xterm's textarea, whose paste event is
  // already owned by the widget.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    const focusedId = focusedTerminalId()
    if (focusedId && input.type === 'keyDown' && input.control && !input.alt && !input.meta) {
      const signal = { c: '\x03', a: '\x01', z: '\x1a', x: '\x18' }[input.key.toLowerCase()]
      if (signal) {
        event.preventDefault()
        terminals.write(focusedId, signal)
      }
    }
  })

  // A crashed renderer cannot dispose its widgets, so its PTYs (and any shell
  // children) would otherwise outlive the window until the app exits. Tear the
  // terminals down the moment the renderer dies instead.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('renderer process gone', details.reason, details.exitCode)
    terminals.disposeAll()
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    void mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Pipe terminal and coordination activity to the renderer so widgets and the
// kanban board stay in sync with whatever agents are doing over MCP.
terminals.on('data', (id: string, chunk: string) => send('terminal:onData', id, chunk))
terminals.on('exit', (id: string, code: number) => send('terminal:onExit', id, code))
coordination.on('change', (snapshot) => send('coordination:onChange', snapshot))

if (hasInstanceLock) {
  app.on('second-instance', focusMainWindow)

  app.whenReady().then(() => {
    // On Windows/Linux, Ctrl+C/V/X/A/Z are wired through the application menu's
    // accelerators, not raw keydown handling — with no Menu at all (this window
    // is frame:false and never shows one), those keys reach focused text areas
    // as literal keystrokes instead of triggering the native paste/copy/cut.
    // `editMenu` registers the accelerators without ever rendering a menu bar.
    Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: 'editMenu' }]))

    // Codex has no per-project config, only this one global file — register the
    // workspace server there once so any `codex` run anywhere already sees it.
    void ensureCodexGlobalConfig()
    // Claude Code reads `.mcp.json` from its cwd, so the equivalent for
    // it is per-project: whichever folder is already open when the app starts.
    // opencode reads its own `opencode.json` from the cwd the same way.
    if (state.workspaceDir) {
      void syncProjectMcpConfig(state.workspaceDir)
      void syncProjectOpencodeConfig(state.workspaceDir)
    }

    // Keep the rail's folder list live whenever the persisted state moves.
    state.on('change', (next) => send('workspace:onRecentChange', next.recent))

    // Handlers first: a transport that submits a command before its handler
    // exists gets `unknown_command`, and the window is created below.
    registerCommands({
      core,
      canvas,
      brain,
      board: coordination,
      terminals,
      requestWidget: (info) => send('control:add-widget', info),
      requestWidgetRemoval: (id) => send('control:remove-widget', id),
      defaultCwd: () => state.workspaceDir
    })

    registerIpc({
      core,
      terminals,
      coordination,
      brain,
      canvas,
      state,
      getWindow: () => mainWindow,
      getWorkspaceDir: () => state.workspaceDir,
      setWorkspaceDir: (dir) => {
        state.setWorkspaceDir(dir)
        // A terminal opened right after picking a folder should already see the
        // workspace's MCP tools, not just ones opened on a later restart.
        if (dir) {
          void syncProjectMcpConfig(dir)
          void syncProjectOpencodeConfig(dir)
        }
        send('workspace:onDirChange', dir ?? null)
      }
    })

    createWindow()

    startControlServer({
      core,
      terminals,
      coordination,
      brain,
      canvas,
      defaultCwd: () => state.workspaceDir,
      mcpRunning: isMcpRunning
    })

    startMcpServer()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  // macOS apps conventionally stay resident with no windows; every other
  // platform expects closing the last window to end the process.
  if (process.platform === 'darwin') return
  terminals.disposeAll()
  stopMcpServer()
  app.quit()
})

app.on('before-quit', () => {
  terminals.disposeAll()
  stopMcpServer()
  // Debounced stores (PERF-004/005): whatever was pending must reach disk
  // before the process dies.
  brain.dispose()
  coordination.dispose()
  canvas.dispose()
  core.dispose()
})
