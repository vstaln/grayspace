import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
// Every exposed module is typed against the same declarations the renderer
// sees (`src/preload/api.ts`, re-exported via `index.d.ts`). Drift between the
// two files is therefore a compile error here instead of a runtime surprise in
// the renderer: the old `Promise<unknown>` bodies silently widened every return
// to a value the renderer's own types could not describe.
import type {
  AppSettings,
  BrainApi,
  BrainNote,
  BrowserApi,
  CanvasApi,
  CanvasSnapshot,
  ControlApi,
  CoordinationApi,
  CoordinationSnapshot,
  FileReadResult,
  FsApi,
  FsListResult,
  GitApi,
  GitStatus,
  McpApi,
  McpStatus,
  MediaApi,
  MediaFile,
  PlanItem,
  PlannerApi,
  RecentDir,
  SettingsApi,
  SystemApi,
  SystemStats,
  Task,
  TaskState,
  TerminalApi,
  WindowApi,
  WorkspaceApi
} from './api.ts'

/** Subscribes to an id-scoped channel, filtering out other terminals' traffic. */
function onScoped<T>(channel: string, id: string, cb: (payload: T) => void): () => void {
  const listener = (_e: IpcRendererEvent, eventId: string, payload: T): void => {
    if (eventId === id) cb(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
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
  /** Main relays a guest page's blocked popup here so the pane opens it as a tab. */
  onOpenTab: (cb: (url: string) => void): (() => void) => onBroadcast('browser:onOpenTab', cb)
}

const terminal: TerminalApi = {
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
  // Invoke, matching the ipcMain.handle: a fire-and-forget `send` never gets
  // the result, so the renderer could not tell a rejected dispose (an agent
  // holds the terminal's lock) from a succeeded one (P10).
  dispose: (id: string): Promise<unknown> => ipcRenderer.invoke('terminal:dispose', id),
  detach: (id: string): void => ipcRenderer.send('terminal:detach', id),
  setFocused: (focused: boolean, id: string): void => ipcRenderer.send('terminal:focus', focused, id),
  onData: (id: string, cb: (data: string) => void): (() => void) => onScoped('terminal:onData', id, cb),
  onExit: (id: string, cb: (exitCode: number) => void): (() => void) => onScoped('terminal:onExit', id, cb)
}

const media: MediaApi = {
  saveClipboard: (): Promise<MediaFile | null> =>
    ipcRenderer.invoke('media:save-clipboard'),
  saveClipboardScratch: (): Promise<MediaFile | null> =>
    ipcRenderer.invoke('media:save-clipboard-scratch'),
  saveBytes: (bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null> =>
    ipcRenderer.invoke('media:save-bytes', bytes, ext),
  saveBytesScratch: (bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null> =>
    ipcRenderer.invoke('media:save-bytes-scratch', bytes, ext),
  dataUrl: (path: string): Promise<string | null> => ipcRenderer.invoke('media:data-url', path)
}

const control: ControlApi = {
  onAddWidget: (cb: (payload: { id: string; title: string; from?: string | null }) => void): (() => void) =>
    onBroadcast('control:add-widget', cb),
  onRemoveWidget: (cb: (id: string) => void): (() => void) => onBroadcast('control:remove-widget', cb)
}

const workspace: WorkspaceApi = {
  getDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:get-dir'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-dir'),
  onDirChange: (cb: (dir: string | null) => void): (() => void) =>
    onBroadcast('workspace:onDirChange', cb),
  // remembered folders
  recent: (): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:recent'),
  openRecent: (path: string): Promise<string | { error: string }> => ipcRenderer.invoke('workspace:open-recent', path),
  pinRecent: (path: string): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:pin-recent', path),
  forgetRecent: (path: string): Promise<RecentDir[]> => ipcRenderer.invoke('workspace:forget-recent', path),
  onRecentChange: (cb: (recent: RecentDir[]) => void): (() => void) =>
    onBroadcast('workspace:onRecentChange', cb)
}

const settings: SettingsApi = {
  get: (): Promise<AppSettings> => ipcRenderer.invoke('settings:get'),
  set: (patch: unknown): Promise<AppSettings> => ipcRenderer.invoke('settings:set', patch),
  getBackground: (): Promise<string | null> => ipcRenderer.invoke('settings:get-background'),
  pickBackground: (): Promise<{ dataUrl?: string | null; error?: string }> =>
    ipcRenderer.invoke('settings:pick-background'),
  clearBackground: (): Promise<null> => ipcRenderer.invoke('settings:clear-background'),
  onChange: (cb: (settings: AppSettings) => void): (() => void) => onBroadcast('settings:onChange', cb)
}

const mcp: McpApi = {
  getStatus: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:getStatus'),
  getUrl: (): Promise<string> => ipcRenderer.invoke('mcp:getUrl'),
  restart: (): Promise<McpStatus> => ipcRenderer.invoke('mcp:restart'),
  onStatusChange: (cb: (status: McpStatus) => void): (() => void) =>
    onBroadcast('mcp:onStatusChange', cb)
}

const coordination: CoordinationApi = {
  status: (): Promise<CoordinationSnapshot> => ipcRenderer.invoke('coordination:status'),
  createTask: (input: {
    title: string
    brief?: string
    state?: TaskState
    tags?: string[]
    dueAt?: number
    assignee?: string
  }): Promise<Task | { error: string }> => ipcRenderer.invoke('coordination:create-task', input),
  updateTask: (
    id: string,
    patch: {
      state?: TaskState
      title?: string
      brief?: string
      tags?: string[]
      dueAt?: number | null
      assignee?: string | null
      baseVersion?: number
    }
  ): Promise<Task | { error: string }> =>
    ipcRenderer.invoke('coordination:update-task', id, patch),
  deleteTask: (id: string): Promise<void | { error: string }> => ipcRenderer.invoke('coordination:delete-task', id),
  resetManager: (): Promise<CoordinationSnapshot> => ipcRenderer.invoke('coordination:reset-manager'),
  releaseLocks: (): Promise<CoordinationSnapshot> => ipcRenderer.invoke('coordination:release-locks'),
  onChange: (cb: (snapshot: CoordinationSnapshot) => void): (() => void) =>
    onBroadcast('coordination:onChange', cb)
}

/**
 * Day outline — not board tasks. Items can be checked off, slotted to a day
 * and time, and reordered by hand. Lives in its own store so the planner stays
 * independent of the kanban "scheduled tasks" view.
 */
const planner: PlannerApi = {
  list: (): Promise<PlanItem[]> => ipcRenderer.invoke('planner:list'),
  create: (input: {
    title: string
    note?: string
    project?: string
    day?: string
    time?: string
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
  commit: (message: string): Promise<{ hash: string } | { error: string }> => ipcRenderer.invoke('git:commit', message)
}

const canvas: CanvasApi = {
  load: (): Promise<CanvasSnapshot> => ipcRenderer.invoke('canvas:load'),
  save: (
    snapshot: unknown
  ): Promise<{ applied: number; skipped: number; removed: number } | { error: string }> =>
    ipcRenderer.invoke('canvas:save', snapshot),
  onChange: (cb: (snapshot: CanvasSnapshot) => void): (() => void) => onBroadcast('canvas:onChange', cb)
}

const brain: BrainApi = {
  list: (): Promise<{ notes: BrainNote[] }> => ipcRenderer.invoke('brain:list'),
  get: (id: string): Promise<BrainNote | null> => ipcRenderer.invoke('brain:get', id),
  create: (input: unknown): Promise<BrainNote | { error: string }> => ipcRenderer.invoke('brain:create', input),
  update: (id: string, patch: unknown): Promise<BrainNote | { error: string; code?: string }> => ipcRenderer.invoke('brain:update', id, patch),
  delete: (id: string): Promise<void | { error: string }> => ipcRenderer.invoke('brain:delete', id),
  trash: (): Promise<BrainNote[]> => ipcRenderer.invoke('brain:trash'),
  restore: (id: string): Promise<BrainNote | { error: string }> => ipcRenderer.invoke('brain:restore', id),
  purge: (id: string): Promise<void | { error: string }> => ipcRenderer.invoke('brain:purge', id),
  onChange: (cb: (snapshot: { notes: BrainNote[] }) => void): (() => void) => onBroadcast('brain:onChange', cb)
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
  stats: (): Promise<SystemStats | { error: string }> => ipcRenderer.invoke('system:stats')
}

contextBridge.exposeInMainWorld('api', {
  terminal,
  control,
  workspace,
  settings,
  mcp,
  media,
  coordination,
  planner,
  brain,
  canvas,
  git,
  fs,
  system,
  browser,
  window: windowControls
})
