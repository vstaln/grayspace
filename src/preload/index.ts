import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'





import type {
  AppSettings,
  ChatApi,
  ChatAuthEvent,
  ChatEvent,
  ChatProvider,
  ChatProviderStatus,
  ChatRequest,
  AgentConversation,
  BrowserApi,
  CanvasApi,
  CanvasDelta,
  CanvasDeltaReplay,
  CanvasSnapshot,
  CodeApi,
  CodeSnapshot,
  ControlApi,
  FileReadResult,
  FsApi,
  FsListResult,
  GitApi,
  GitStatus,
  OrchestrationApi,
  OrcMessage,
  OrcSnapshot,
  MediaApi,
  MediaFile,
  PlanItem,
  PlannerApi,
  RecentDir,
  SettingsApi,
  SystemApi,
  SystemStats,
  TerminalApi,
  WindowApi,
  WorkspaceApi
} from './api.ts'

type ScopedCb<T> = (payload: T) => void
const scopedChannelMap = new Map<
  string,
  {
    subscribers: Map<string, Set<ScopedCb<any>>>
    ipcListener: (_e: IpcRendererEvent, eventId: string, payload: any) => void
  }
>()


function onScoped<T>(channel: string, id: string, cb: (payload: T) => void): () => void {
  let entry = scopedChannelMap.get(channel)
  if (!entry) {
    const subscribers = new Map<string, Set<ScopedCb<any>>>()
    const ipcListener = (_e: IpcRendererEvent, eventId: string, payload: any): void => {
      const set = subscribers.get(eventId)
      if (set) {
        for (const fn of set) {
          try {
            fn(payload)
          } catch (err) {
            console.error(`Error in scoped subscriber for ${channel}:${eventId}`, err)
          }
        }
      }
    }
    ipcRenderer.on(channel, ipcListener)
    entry = { subscribers, ipcListener }
    scopedChannelMap.set(channel, entry)
  }

  let idSubscribers = entry.subscribers.get(id)
  if (!idSubscribers) {
    idSubscribers = new Set()
    entry.subscribers.set(id, idSubscribers)
  }
  idSubscribers.add(cb as ScopedCb<any>)

  return () => {
    const cur = scopedChannelMap.get(channel)
    if (!cur) return
    const set = cur.subscribers.get(id)
    if (set) {
      set.delete(cb as ScopedCb<any>)
      if (set.size === 0) cur.subscribers.delete(id)
    }
    if (cur.subscribers.size === 0) {
      ipcRenderer.removeListener(channel, cur.ipcListener)
      scopedChannelMap.delete(channel)
    }
  }
}

function onBroadcast<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const windowControls: WindowApi = {
  minimize: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('window:toggle-maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) =>
    onBroadcast('window:onMaximizeChange', cb)
}

const browser: BrowserApi = {

  onOpenTab: (cb: (url: string) => void): (() => void) => onBroadcast('browser:onOpenTab', cb),
  clearData: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('browser:clear-data')
}

const terminal: TerminalApi = {
  list: (): Promise<Array<{ id: string; title: string; cwd: string }>> => ipcRenderer.invoke('terminal:list'),
  create: (
    id: string,
    cols?: number,
    rows?: number
  ): Promise<
    { ok: boolean; error?: string; scrollback?: string; live?: boolean } | { error: string }
  > => ipcRenderer.invoke('terminal:create', id, cols, rows),
  write: (id: string, data: string): Promise<{ ok: true } | { error: string; code?: string }> =>
    ipcRenderer.invoke('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),



  dispose: (id: string): Promise<unknown> => ipcRenderer.invoke('terminal:dispose', id),
  setTitle: (id: string, title: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:set-title', id, title),
  detach: (id: string): void => ipcRenderer.send('terminal:detach', id),
  setFocused: (focused: boolean, id: string): void => ipcRenderer.send('terminal:focus', focused, id),
  onData: (id: string, cb: (data: string) => void): (() => void) => onScoped('terminal:onData', id, cb),
  onExit: (id: string, cb: (exitCode: number) => void): (() => void) => onScoped('terminal:onExit', id, cb),
  onBackendError: (cb: (message: string) => void): (() => void) => onBroadcast('terminal:onBackendError', cb)
}

const media: MediaApi = {
  saveClipboard: (): Promise<MediaFile | null> =>
    ipcRenderer.invoke('media:save-clipboard'),
  readClipboardText: (): Promise<string> => ipcRenderer.invoke('media:read-clipboard-text'),
  writeClipboardText: (text: string): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('media:write-clipboard-text', text),
  saveClipboardScratch: (): Promise<MediaFile | null> =>
    ipcRenderer.invoke('media:save-clipboard-scratch'),
  stageClipboardImage: (bytes: Uint8Array): Promise<{ ok: true } | { error: string }> =>
    ipcRenderer.invoke('media:stage-clipboard-image', bytes),
  saveBytes: (bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null> =>
    ipcRenderer.invoke('media:save-bytes', bytes, ext),
  saveBytesScratch: (bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null> =>
    ipcRenderer.invoke('media:save-bytes-scratch', bytes, ext),
  dataUrl: (path: string): Promise<string | null> => ipcRenderer.invoke('media:data-url', path),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file)
}

const control: ControlApi = {
  onAddWidget: (
    cb: (payload: { id: string; title: string; kind?: string; x?: number; y?: number; from?: string | null }) => void
  ): (() => void) => onBroadcast('control:add-widget', cb),
  onRemoveWidget: (cb: (id: string) => void): (() => void) => onBroadcast('control:remove-widget', cb),
  onRenameWidget: (cb: (payload: { id: string; title: string }) => void): (() => void) =>
    onBroadcast('control:rename-widget', cb),
  onOpenMedia: (
    cb: (payload: { widgetId: string; path: string; name: string; mediaUrl: string; kind: string }) => void
  ): (() => void) => onBroadcast('control:open-media', cb)
}

const workspace: WorkspaceApi = {
  getDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:get-dir'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-dir'),
  create: (name: string): Promise<string | { error: string } | null> => ipcRenderer.invoke('workspace:create', name),
  rename: (path: string, name: string): Promise<RecentDir[] | { error: string }> => ipcRenderer.invoke('workspace:rename', path, name),
  codeWorkspaces: () => ipcRenderer.invoke('workspace:code-workspaces'),
  codeWorkspaceGroups: () => ipcRenderer.invoke('workspace:code-workspace-groups'),
  createCodeWorkspace: (name?: string, folder?: string) =>
    folder ? ipcRenderer.invoke('workspace:create-code', folder, name ?? null) : ipcRenderer.invoke('workspace:create-code', name),
  renameCodeWorkspace: (id: string, name: string, folder?: string) =>
    folder ? ipcRenderer.invoke('workspace:rename-code', folder, id, name) : ipcRenderer.invoke('workspace:rename-code', id, name),
  deleteCodeWorkspace: (id: string, folder?: string) =>
    folder ? ipcRenderer.invoke('workspace:delete-code', folder, id) : ipcRenderer.invoke('workspace:delete-code', id),
  selectCodeWorkspace: (id: string) => ipcRenderer.invoke('workspace:select-code', id),
  onCodeWorkspaceChange: (cb) => onBroadcast('workspace:onCodeWorkspaceChange', cb),
  onCodeWorkspaceDeleted: (cb) => onBroadcast('workspace:onCodeWorkspaceDeleted', cb),
  onDirChange: (cb: (dir: string | null) => void): (() => void) =>
    onBroadcast('workspace:onDirChange', cb),

  recent: (): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:recent'),
  openRecent: (path: string): Promise<string | { error: string }> => ipcRenderer.invoke('workspace:open-recent', path),
  pinRecent: (path: string): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:pin-recent', path),
  forgetRecent: (path: string): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:forget-recent', path),
  onRecentChange: (cb: (recent: RecentDir[]) => void): (() => void) =>
    onBroadcast('workspace:onRecentChange', cb)
}

const settings: SettingsApi = {
  updateState: () => ipcRenderer.invoke('updates:state'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  set: (patch: unknown): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
  getBackground: (): Promise<string | null> => ipcRenderer.invoke('settings:get-background'),
  pickBackground: (): Promise<{ dataUrl?: string | null; error?: string }> =>
    ipcRenderer.invoke('settings:pick-background'),
  clearBackground: (): Promise<null> => ipcRenderer.invoke('settings:clear-background'),
  onChange: (cb: (settings: AppSettings) => void): (() => void) => onBroadcast('settings:onChange', cb)
}

const chat: ChatApi = {
  providers: (): Promise<ChatProviderStatus[]> => ipcRenderer.invoke('chat:providers'),
  connect: (provider: ChatProvider): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:connect', provider),
  submitAuthCode: (provider: ChatProvider, code: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:auth-submit', provider, code),
  send: (request: ChatRequest): Promise<{ ok: boolean; requestId?: string; error?: string }> => ipcRenderer.invoke('chat:send', request),
  cancel: (widgetId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('chat:cancel', widgetId),
  onEvent: (cb: (event: ChatEvent) => void): (() => void) => onBroadcast('chat:event', cb),
  onAuthEvent: (cb: (event: ChatAuthEvent) => void): (() => void) => onBroadcast('chat:auth-event', cb)
}

const orchestration: OrchestrationApi = {
  snapshot: (runId?: string): Promise<OrcSnapshot> => ipcRenderer.invoke('orchestration:snapshot', runId),
  inbox: (runId?: string): Promise<OrcMessage[]> => ipcRenderer.invoke('orchestration:inbox', runId),
  reply: (askId: string, body: string): Promise<unknown> => ipcRenderer.invoke('orchestration:reply', askId, body),
  respondToPermission: (askId: string, approved: boolean, note?: string): Promise<unknown> =>
    ipcRenderer.invoke('orchestration:permission', askId, approved, note),
  resolveGate: (gateId: string, resolution: string): Promise<unknown> =>
    ipcRenderer.invoke('orchestration:resolve-gate', gateId, resolution),
  account: (dispatchId: string, state: 'retained' | 'released', closeTerminal?: boolean): Promise<unknown> =>
    ipcRenderer.invoke('orchestration:account', dispatchId, state, closeTerminal),
  closeRun: (runId: string): Promise<unknown> => ipcRenderer.invoke('orchestration:close-run', runId),
  onChange: (cb: () => void): (() => void) => onBroadcast('orchestration:onChange', cb)
}

const planner: PlannerApi = {
  list: (): Promise<PlanItem[]> => ipcRenderer.invoke('planner:list'),
  create: (input: {
    title: string
    note?: string
    project?: string
    day?: string
    time?: string
    attachments?: string[]
  }): Promise<PlanItem | { error: string }> => ipcRenderer.invoke('planner:create', input),
  update: (
    id: string,
    patch: {
      title?: string
      note?: string
      project?: string | null
      day?: string | null
      time?: string | null
      done?: boolean
      order?: number
      attachments?: string[] | null
      baseVersion?: number
    }
  ): Promise<PlanItem | { error: string }> => ipcRenderer.invoke('planner:update', id, patch),
  toggle: (id: string, done?: boolean, baseVersion?: number): Promise<PlanItem | { error: string }> =>
    ipcRenderer.invoke('planner:toggle', id, done, baseVersion),
  delete: (id: string): Promise<void | { error: string }> => ipcRenderer.invoke('planner:delete', id),
  onChange: (cb: (items: PlanItem[]) => void): (() => void) => onBroadcast('planner:onChange', cb)
}

const git: GitApi = {
  status: (): Promise<GitStatus | { error: string }> => ipcRenderer.invoke('git:status'),
  commit: (message: string): Promise<{ hash: string } | { error: string }> => ipcRenderer.invoke('git:commit', message),
  branches: () => ipcRenderer.invoke('git:branches'),
  log: (options?: { limit?: number; query?: string }) => ipcRenderer.invoke('git:log', options ?? {}),
  checkout: (ref: string) => ipcRenderer.invoke('git:checkout', ref),
  createBranch: (name: string, startPoint?: string) => ipcRenderer.invoke('git:create-branch', name, startPoint ?? '')
}

const canvas: CanvasApi = {
  load: (): Promise<CanvasSnapshot> => ipcRenderer.invoke('canvas:load'),
  replay: (since?: number): Promise<CanvasDeltaReplay> => ipcRenderer.invoke('canvas:replay', since),
  updateWidget: (id, patch, baseVersion) => ipcRenderer.invoke('canvas:update-widget', id, patch, baseVersion),
  save: (
    snapshot: unknown
  ): Promise<{ applied: number; skipped: number; removed: number } | { error: string }> =>
    ipcRenderer.invoke('canvas:save', snapshot),
  onChange: (cb: (snapshot: CanvasSnapshot) => void): (() => void) => onBroadcast('canvas:onChange', cb),
  onDelta: (cb: (delta: CanvasDelta) => void): (() => void) => onBroadcast('canvas:onDelta', cb)
}

const code: CodeApi = {
  load: (): Promise<CodeSnapshot> => ipcRenderer.invoke('code:load'),
  conversations: (dir?: string): Promise<AgentConversation[]> => ipcRenderer.invoke('code:conversations', dir),
  save: (snapshot: unknown): Promise<{ ok: boolean } | { error: string }> =>
    ipcRenderer.invoke('code:save', snapshot),
  saveSync: (snapshot: unknown): { ok: boolean } | { error: string } =>
    ipcRenderer.sendSync('code:save-sync', snapshot),
  onChange: (cb: (snapshot: CodeSnapshot) => void): (() => void) => onBroadcast('code:onChange', cb)
}

const fs: FsApi = {
  list: (dirPath?: string, options?: { showHidden?: boolean }): Promise<FsListResult | { error: string }> =>
    ipcRenderer.invoke('fs:list', dirPath, options),
  readFile: (filePath: string, maxBytes?: number): Promise<FileReadResult | { error: string }> =>
    ipcRenderer.invoke('fs:read-file', filePath, maxBytes),
  writeFile: (filePath: string, content: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:write-file', filePath, content),
  createFile: (filePath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:create-file', filePath),
  createDir: (dirPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:create-dir', dirPath),
  delete: (targetPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:delete', targetPath),
  rename: (oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:rename', oldPath, newPath),
  reveal: (targetPath: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:reveal', targetPath),
  openPath: (targetPath: string): Promise<{ ok?: boolean; error?: string }> =>
    ipcRenderer.invoke('fs:open-path', targetPath)
}

const system: SystemApi = {
  stats: (): Promise<SystemStats | { error: string }> => ipcRenderer.invoke('system:stats'),
  releaseLocks: (): Promise<{ ok: boolean } | { error: string }> => ipcRenderer.invoke('system:release-locks'),
  onPersistError: (cb: (payload: { store: string; message: string; at: number }) => void): (() => void) =>
    onBroadcast('system:persistError', cb)
}

contextBridge.exposeInMainWorld('api', {
  terminal,
  control,
  workspace,
  settings,
  chat,
  media,
  orchestration,
  planner,
  canvas,
  code,
  git,
  fs,
  system,
  browser,
  window: windowControls
})
