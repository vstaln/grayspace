
import { config as loadEnvFile } from 'dotenv'
loadEnvFile()

import { app, Menu } from 'electron'
import { join } from 'path'
import { IS_MAC, initAppSwitches, requestInstanceLock, initAutoUpdater, registerProtocols } from './bootstrap.ts'
import { setupOrcProtocol, setupMediaHeaders } from './protocol.ts'
import { createAppStores } from './appStores.ts'
import {
  createWindow,
  focusMainWindow,
  getMainWindow,
  handleSecondInstanceArgs,
  publishPresence,
  send,
  setupWebContentsHandlers
} from './windowManager.ts'
import { setupKeyboardShortcuts, setupTerminalEvents } from './terminalEvents.ts'
import { setupLifecycle } from './appLifecycle.ts'
import { startControlServer } from './controlServer'
import { controlTcpEnabled } from './config.ts'
import { captureScreen } from './screenshot.ts'
import { ensureOrcExecutable } from './orcCli.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import { writeRuntimePresence } from './runtimePresence'
import { registerIpc, originTerminalId, forgetTerminalOrigin } from './ipc/index.ts'
import { registerCommands } from './commands/index.ts'
import { onPersistError } from './persistNotifier.ts'


registerProtocols()
initAppSwitches()
if (process.env.ORCSPACE_DEV_USER_DATA) {
  try {
    app.setPath('userData', process.env.ORCSPACE_DEV_USER_DATA)
  } catch (err) {
    console.warn('Failed to set custom userData path:', err)
  }
}
const hasInstanceLock = requestInstanceLock()
if (!hasInstanceLock) {
  app.quit()
  throw new Error('Another OrcSpace instance is already running')
}


onPersistError((payload) => send('system:persistError', payload))


const {
  core,
  state,
  terminals,
  terminalBatcher,
  snapshots,
  canvas,
  code,
  planner,
  orchestration,
} = createAppStores()

let controlServer: { close(): void } | null = null
let orchestrationSignal: ReturnType<typeof setTimeout> | null = null
let shuttingDown = false

function doPublishPresence(): void {
  publishPresence(state, (payload) => writeRuntimePresence(payload))
}

function syncAgentConfigsFor(dir: string): void {
  syncOrcGuide(dir)
}

function applyWorkspaceDir(dir: string | undefined): void {
  const previous = state.workspaceDir
  state.setWorkspaceDir(dir)
  if ((dir || undefined) === previous) return
  const codeWorkspace = state.codeWorkspaceState(dir)
  code.setWorkspaceScope(
    state.activeCodeWorkspaceScope(dir),
    codeWorkspace.activeId === codeWorkspace.workspaces[0]?.id ? dir : undefined,
    dir
  )
  if (dir) syncAgentConfigsFor(dir)
  send('workspace:onDirChange', dir ?? null)
  send('workspace:onCodeWorkspaceChange', state.codeWorkspaceState(dir))
  doPublishPresence()
}


setupKeyboardShortcuts(terminals)
setupTerminalEvents({
  terminals,
  terminalBatcher,
  snapshots,
  planner,
  canvas,
  code,
  send,
  isShuttingDown: () => shuttingDown
})
setupWebContentsHandlers(send)
setupLifecycle({
  terminals,
  snapshots,
  planner,
  canvas,
  code,
  core,
  orchestration,
  state,
  getControlServer: () => controlServer,
  setControlServer: (v) => { controlServer = v },
  getOrchestrationSignal: () => orchestrationSignal,
  setOrchestrationSignal: (v) => { orchestrationSignal = v },
  isShuttingDown: () => shuttingDown,
  setShuttingDown: (v) => { shuttingDown = v }
})

// hasInstanceLock is always true here: requestInstanceLock() returning
// false throws above and exits this module before this point is reached.
app.on('second-instance', (_event, argv) =>
  handleSecondInstanceArgs(argv, { setWorkspaceDir: (dir) => applyWorkspaceDir(dir), send, focus: focusMainWindow })
)

app.whenReady().then(() => {
  setupOrcProtocol()
  setupMediaHeaders()
  if (process.platform === 'win32') {
    app.setAppUserModelId(app.isPackaged ? 'com.orcspace.app' : 'com.orcspace.app.dev')
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
    doPublishPresence()
  })

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
    planner,
    orchestration,
    canvas,
    code,
    state,
    getWindow: () => getMainWindow(),
    getWorkspaceDir: () => state.workspaceDir,
    setWorkspaceDir: (dir) => applyWorkspaceDir(dir)
  })

  controlServer = startControlServer({
    allowTcp: controlTcpEnabled(app.isPackaged),
    core,
    terminals,
    planner,
    orchestration,
    canvas,
    state,
    rendererDir: process.env['ELECTRON_RENDERER_URL'] ? undefined : join(__dirname, '../renderer'),
    defaultCwd: () => state.workspaceDir,
    broadcast: (channel, payload) => send(channel, payload),
    capture: (widgetId) => captureScreen(getMainWindow(), widgetId),
    onPortAssigned: () => doPublishPresence(),
    onSocketAssigned: () => doPublishPresence()
  })

  ensureOrcExecutable()
  createWindow()

  doPublishPresence()
  initAutoUpdater()

  app.on('activate', () => {
    if (getMainWindow() === null || getMainWindow()!.isDestroyed()) createWindow()
    else focusMainWindow()
  })
}).catch((err) => {
  console.error('app startup failed', err)
})
