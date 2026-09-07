// Loaded first: config reads process.env at import time
import { config as loadEnvFile } from 'dotenv'
loadEnvFile()

import { app, Menu } from 'electron'
import { join } from 'path'
import { IS_MAC, initAppSwitches, requestInstanceLock, initAutoUpdater } from './bootstrap.ts'
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
import { setupLifecycle, snapshotTerminals } from './appLifecycle.ts'
import { APP_TITLE } from './config'
import { startControlServer } from './controlServer'
import { ensureOrcExecutable } from './orcCli.ts'
import { syncOrcGuide } from './orchestration/guide.ts'
import { clearRuntimePresence, writeRuntimePresence } from './runtimePresence'
import { registerIpc, originTerminalId, forgetTerminalOrigin } from './ipc'
import { registerCommands } from './commands/index.ts'
import { onPersistError } from './persistNotifier.ts'
import { chatRunner } from './chatRunner.ts'

// --- bootstrap ---
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
  // bootstrap already called app.exit(0)
}

// shared broadcast for persist errors -> renderer toast
onPersistError((payload) => send('system:persistError', payload))

// --- stores ---
const {
  core,
  state,
  terminals,
  terminalBatcher,
  snapshots,
  coordination,
  canvas,
  code,
  planner,
  orchestration,
  disposePlannerSync
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

// --- events ---
setupKeyboardShortcuts(terminals)
setupTerminalEvents({
  terminals,
  terminalBatcher,
  snapshots,
  coordination,
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
  coordination,
  planner,
  canvas,
  code,
  chat: chatRunner,
  core,
  orchestration,
  disposePlannerSync,
  getControlServer: () => controlServer,
  setControlServer: (v) => { controlServer = v },
  getOrchestrationSignal: () => orchestrationSignal,
  setOrchestrationSignal: (v) => { orchestrationSignal = v },
  isShuttingDown: () => shuttingDown,
  setShuttingDown: (v) => { shuttingDown = v }
})

if (hasInstanceLock) {
  app.on('second-instance', (_event, argv) =>
    handleSecondInstanceArgs(argv, { state, send, focus: focusMainWindow })
  )

  app.whenReady().then(() => {
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
      getWindow: () => getMainWindow(),
      getWorkspaceDir: () => state.workspaceDir,
      setWorkspaceDir: (dir) => {
        const previous = state.workspaceDir
        state.setWorkspaceDir(dir)
        if ((dir || undefined) === previous) return
        const codeWorkspace = state.codeWorkspaceState(dir)
        code.setWorkspaceScope(
          state.activeCodeWorkspaceScope(dir),
          codeWorkspace.activeId === codeWorkspace.workspaces[0]?.id ? dir : undefined
        )
        if (dir) syncAgentConfigsFor(dir)
        send('workspace:onDirChange', dir ?? null)
        send('workspace:onCodeWorkspaceChange', state.codeWorkspaceState(dir))
      }
    })

    controlServer = startControlServer({
      core,
      terminals,
      coordination,
      planner,
      orchestration,
      canvas,
      state,
      rendererDir: process.env['ELECTRON_RENDERER_URL'] ? undefined : join(__dirname, '../renderer'),
      defaultCwd: () => state.workspaceDir,
      broadcast: (channel, payload) => send(channel, payload),
      onPortAssigned: () => doPublishPresence()
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
}
