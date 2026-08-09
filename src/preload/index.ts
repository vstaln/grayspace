import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'

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

const windowControls = {
  minimize: (): void => ipcRenderer.send('window:minimize'),
  toggleMaximize: (): void => ipcRenderer.send('window:toggle-maximize'),
  close: (): void => ipcRenderer.send('window:close'),
  isMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  onMaximizeChange: (cb: (maximized: boolean) => void): (() => void) =>
    onBroadcast('window:onMaximizeChange', cb)
}

const terminal = {
  create: (id: string, cols?: number, rows?: number): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('terminal:create', id, cols, rows),
  write: (id: string, data: string): void => ipcRenderer.send('terminal:write', id, data),
  resize: (id: string, cols: number, rows: number): void =>
    ipcRenderer.send('terminal:resize', id, cols, rows),
  dispose: (id: string): void => ipcRenderer.send('terminal:dispose', id),
  setFocused: (focused: boolean, id: string): void => ipcRenderer.send('terminal:focus', focused, id),
  onData: (id: string, cb: (data: string) => void): (() => void) => onScoped('terminal:onData', id, cb),
  onExit: (id: string, cb: (exitCode: number) => void): (() => void) => onScoped('terminal:onExit', id, cb)
}

const media = {
  saveClipboard: (): Promise<{ name: string; path: string } | null> =>
    ipcRenderer.invoke('media:save-clipboard'),
  saveBytes: (bytes: Uint8Array, ext: string): Promise<{ name: string; path: string } | { error: string } | null> =>
    ipcRenderer.invoke('media:save-bytes', bytes, ext),
  dataUrl: (path: string): Promise<string | null> => ipcRenderer.invoke('media:data-url', path)
}

const chat = {
  send: (request: { id: string; provider: 'claude' | 'codex' | 'opencode' | 'openrouter'; prompt: string; model: string; effort: 'low' | 'medium' | 'high'; mode: 'fast' | 'build' | 'plan' }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('chat:send', request),
  cancel: (id: string): void => ipcRenderer.send('chat:cancel', id),
  models: (force?: boolean): Promise<unknown> => ipcRenderer.invoke('chat:models', force),
  onEvent: (cb: (event: { id: string; type: 'delta' | 'done' | 'error'; text?: string; error?: string }) => void): (() => void) => onBroadcast('chat:event', cb)
}

const control = {
  onAddWidget: (cb: (payload: { id: string; title: string }) => void): (() => void) =>
    onBroadcast('control:add-widget', cb),
  onRemoveWidget: (cb: (id: string) => void): (() => void) => onBroadcast('control:remove-widget', cb)
}

const workspace = {
  getDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:get-dir'),
  pickDir: (): Promise<string | null> => ipcRenderer.invoke('workspace:pick-dir'),
  onDirChange: (cb: (dir: string | null) => void): (() => void) =>
    onBroadcast('workspace:onDirChange', cb),
  // remembered folders
  recent: (): Promise<unknown> => ipcRenderer.invoke('workspace:recent'),
  openRecent: (path: string): Promise<unknown> => ipcRenderer.invoke('workspace:open-recent', path),
  pinRecent: (path: string): Promise<unknown> => ipcRenderer.invoke('workspace:pin-recent', path),
  forgetRecent: (path: string): Promise<unknown> => ipcRenderer.invoke('workspace:forget-recent', path),
  onRecentChange: (cb: (recent: unknown) => void): (() => void) =>
    onBroadcast('workspace:onRecentChange', cb)
}

const settings = {
  get: (): Promise<unknown> => ipcRenderer.invoke('settings:get'),
  set: (patch: unknown): Promise<unknown> => ipcRenderer.invoke('settings:set', patch),
  getBackground: (): Promise<string | null> => ipcRenderer.invoke('settings:get-background'),
  pickBackground: (): Promise<{ dataUrl?: string | null; error?: string }> =>
    ipcRenderer.invoke('settings:pick-background'),
  clearBackground: (): Promise<null> => ipcRenderer.invoke('settings:clear-background')
}

const coordination = {
  status: (): Promise<unknown> => ipcRenderer.invoke('coordination:status'),
  createTask: (input: {
    title: string
    brief?: string
    state?: string
    tags?: string[]
    dueAt?: number
    assignee?: string
  }): Promise<unknown> => ipcRenderer.invoke('coordination:create-task', input),
  updateTask: (
    id: string,
    patch: {
      state?: string
      title?: string
      brief?: string
      tags?: string[]
      dueAt?: number | null
      assignee?: string | null
    }
  ): Promise<unknown> =>
    ipcRenderer.invoke('coordination:update-task', id, patch),
  deleteTask: (id: string): Promise<unknown> => ipcRenderer.invoke('coordination:delete-task', id),
  resetManager: (): Promise<unknown> => ipcRenderer.invoke('coordination:reset-manager'),
  releaseLocks: (): Promise<unknown> => ipcRenderer.invoke('coordination:release-locks'),
  onChange: (cb: (snapshot: unknown) => void): (() => void) =>
    onBroadcast('coordination:onChange', cb)
}

/**
 * The built-in assistant. `start` resolves when the run finishes *or* parks at
 * the human gate — a parked run comes back with `status: 'waiting_human'` and
 * a question, and `answer` continues it from the same step.
 */
const assistant = {
  start: (goal: string): Promise<unknown> => ipcRenderer.invoke('assistant:start', goal),
  answer: (runId: string, approved: boolean, note?: string): Promise<unknown> =>
    ipcRenderer.invoke('assistant:answer', runId, approved, note),
  cancel: (runId: string): Promise<unknown> => ipcRenderer.invoke('assistant:cancel', runId),
  runs: (): Promise<unknown> => ipcRenderer.invoke('assistant:runs'),
  onRun: (cb: (run: unknown) => void): (() => void) => onBroadcast('assistant:onRun', cb)
}

const canvas = {
  load: (): Promise<unknown> => ipcRenderer.invoke('canvas:load'),
  save: (snapshot: unknown): Promise<void> => ipcRenderer.invoke('canvas:save', snapshot)
}

const brain = {
  list: (): Promise<unknown> => ipcRenderer.invoke('brain:list'),
  create: (input: unknown): Promise<unknown> => ipcRenderer.invoke('brain:create', input),
  update: (id: string, patch: unknown): Promise<unknown> => ipcRenderer.invoke('brain:update', id, patch),
  delete: (id: string): Promise<void> => ipcRenderer.invoke('brain:delete', id),
  trash: (): Promise<unknown> => ipcRenderer.invoke('brain:trash'),
  restore: (id: string): Promise<unknown> => ipcRenderer.invoke('brain:restore', id),
  purge: (id: string): Promise<void> => ipcRenderer.invoke('brain:purge', id),
  graph: (): Promise<unknown> => ipcRenderer.invoke('brain:graph')
}

contextBridge.exposeInMainWorld('api', {
  terminal,
  control,
  workspace,
  settings,
  media,
  coordination,
  brain,
  canvas,
  chat,
  assistant,
  window: windowControls
})
