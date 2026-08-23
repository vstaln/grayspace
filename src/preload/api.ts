export type TaskState = 'backlog' | 'queued' | 'in_progress' | 'review' | 'done' | 'cancelled'

export interface Task {
  id: string
  title: string
  brief: string
  files: string[]
  state: TaskState
  createdBy: string
  assignee?: string
  tags: string[]
  dueAt?: number
  maxSteps: number
  maxReviewIterations: number
  createdAt: number
  updatedAt: number
  /** Optimistic-concurrency version; send it back as `baseVersion` to edit safely. */
  version: number
}

/**
 * A live lock on a resource, addressed `scheme:id` (`file:src/a.ts`,
 * `note:n1`, `git:repo`). Locks are never persisted — every holder is dead
 * after a restart — and every one of them expires on its own TTL.
 */
export interface ResourceLock {
  resource: string
  actorId: string
  acquiredAt: number
  expiresAt: number
  reason?: string
  implicit: boolean
}

export interface CoordinationSnapshot {
  managerId: string | null
  tasks: Task[]
  locks: ResourceLock[]
}

export interface TerminalApi {
  create(
    id: string,
    cols?: number,
    rows?: number
  ): Promise<
    { ok: boolean; error?: string; scrollback?: string; live?: boolean } | { error: string }
  >
  write(id: string, data: string): Promise<{ ok: true } | { error: string; code?: string }>
  resize(id: string, cols: number, rows: number): void
  dispose(id: string): Promise<unknown>
  /**
   * Widget unmounted without an intentional close (folder switch, redraw).
   * Parks the shell — does not kill Claude Code or other long sessions.
   */
  detach(id: string): void
  /** Reports whether this terminal widget currently holds keyboard focus. */
  setFocused(focused: boolean, id: string): void
  onData(id: string, cb: (data: string) => void): () => void
  onExit(id: string, cb: (exitCode: number) => void): () => void
}

export interface ControlApi {
  onAddWidget(cb: (payload: { id: string; title: string; from?: string | null }) => void): () => void
  onRemoveWidget(cb: (id: string) => void): () => void
}

export interface RecentDir {
  path: string
  name: string
  pinned: boolean
  lastOpenedAt: number
}

export interface WorkspaceApi {
  getDir(): Promise<string | null>
  pickDir(): Promise<string | null>
  onDirChange(cb: (dir: string | null) => void): () => void
  recent(): Promise<RecentDir[]>
  openRecent(path: string): Promise<string | { error: string }>
  pinRecent(path: string): Promise<RecentDir[]>
  forgetRecent(path: string): Promise<RecentDir[]>
  onRecentChange(cb: (recent: RecentDir[]) => void): () => void
}

export type LinkSyntax = 'wiki' | 'dollar' | 'both'
export type UserRole = 'member' | 'lead'
export type UserPlan = 'free' | 'plus'

export interface LocalModelSettings {
  enabled: boolean
  serverBin: string
  modelPath: string
  mmprojPath?: string
  contextSize: number
  gpuLayers: number
  idleTimeoutMs: number
  offloadVision: boolean
}

export interface AppSettings {
  linkSyntax: LinkSyntax
  role: UserRole
  plan?: UserPlan
  userName: string
  backgroundImage?: string
  /** 0–90 % black laid over the wallpaper. */
  backgroundDim: number
  /** 0–90 % blur applied to the wallpaper. */
  backgroundBlur: number
  /** Masked Telegram bot token; the plaintext token stays in the main process. */
  telegramBotToken?: string
  /** Allowed Telegram user ID. */
  telegramUserId?: string
  /** Legacy alias for telegramUserId. */
  telegramChatId?: string
  targetTerminalId?: string
  /** Model the built-in assistant plans with. */
  assistantModel?: string
  localModel: LocalModelSettings
}

export interface SettingsApi {
  get(): Promise<AppSettings>
  set(
    patch: Partial<
      Omit<
        AppSettings,
        | 'backgroundImage'
        | 'localModel'
      >
    > & {
      backgroundImage?: string | null
      telegramBotToken?: string | null
      telegramUserId?: string | null
      telegramChatId?: string | null
      localModel?: Partial<LocalModelSettings>
    }
  ): Promise<AppSettings>
  /** The stored wallpaper as a data URL, or null when none is set. */
  getBackground(): Promise<string | null>
  pickBackground(): Promise<{ dataUrl?: string | null; error?: string }>
  clearBackground(): Promise<null>
  onChange(cb: (settings: AppSettings) => void): () => void
}

export interface McpStatus {
  entrypoint: string
  running: boolean
  error?: string
  restarts: number
  pid?: number
}

export interface McpApi {
  getStatus(): Promise<McpStatus>
  getUrl(): Promise<string>
  restart(): Promise<McpStatus>
  onStatusChange(cb: (status: McpStatus) => void): () => void
}

export interface TelegramStatus {
  state: 'disconnected' | 'connected' | 'error'
  lastMessage?: string
  error?: string
}

export interface TelegramApi {
  getStatus(): Promise<TelegramStatus>
  save(patch: {
    telegramBotToken?: string | null
    telegramUserId?: string | null
    telegramChatId?: string | null
    targetTerminalId?: string | null
  }): Promise<TelegramStatus>
  testSend(): Promise<{ ok: true } | { error: string }>
  onStatusChange(cb: (status: TelegramStatus) => void): () => void
}

/** A picture copied into the app's own store, addressable by absolute path. */
export interface MediaFile { name: string; path: string }

export interface MediaApi {
  /** Saves the clipboard bitmap, or null when the clipboard holds no image. */
  saveClipboard(): Promise<MediaFile | null>
  saveBytes(bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null>
  /** Reads an image back as a data URL; null when missing or not an image. */
  dataUrl(path: string): Promise<string | null>
}

export interface CoordinationApi {
  status(): Promise<CoordinationSnapshot>
  createTask(input: {
    title: string
    brief?: string
    state?: TaskState
    tags?: string[]
    dueAt?: number
    assignee?: string
  }): Promise<Task | { error: string }>
  updateTask(
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
  ): Promise<Task | { error: string }>
  deleteTask(id: string): Promise<void | { error: string }>
  resetManager(): Promise<CoordinationSnapshot>
  releaseLocks(): Promise<CoordinationSnapshot>
  onChange(cb: (snapshot: CoordinationSnapshot) => void): () => void
}

/**
 * One line of the personal day plan. Distinct from a board {@link Task}: no
 * assignee, no state machine — just a hand-ordered outline the human (or a
 * manager agent) can check off.
 */
export interface PlanItem {
  id: string
  title: string
  note: string
  /** Optional group label shown in the planner sidebar (e.g. "Update 1.0.27"). */
  project?: string
  /** `YYYY-MM-DD`, or unset when the item is not slotted to a day. */
  day?: string
  /** `HH:MM`, or unset when there is no particular time. */
  time?: string
  done: boolean
  createdBy: string
  order: number
  createdAt: number
  updatedAt: number
  version: number
}

export interface PlannerApi {
  list(): Promise<PlanItem[]>
  create(input: {
    title: string
    note?: string
    project?: string
    day?: string
    time?: string
  }): Promise<PlanItem | { error: string }>
  update(
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
  ): Promise<PlanItem | { error: string }>
  /** Check / uncheck. Omit `done` to flip. */
  toggle(id: string, done?: boolean, baseVersion?: number): Promise<PlanItem | { error: string }>
  delete(id: string): Promise<void | { error: string }>
  onChange(cb: (items: PlanItem[]) => void): () => void
}



export interface BrainNote {
  id: string
  title: string
  content: string
  tags: string[]
  createdAt: number
  updatedAt: number
  projectDir?: string
  folder?: string
  color?: string
  links?: string[]
  unresolved?: string[]
  deletedAt?: number
  version: number
}

export interface BrainApi {
  list(): Promise<{ notes: BrainNote[] }>
  /** One note by id, or null — without serializing the whole store. */
  get(id: string): Promise<BrainNote | null>
  create(input: Partial<BrainNote>): Promise<BrainNote | { error: string }>
  update(
    id: string,
    patch: Partial<BrainNote> & { baseVersion?: number }
  ): Promise<BrainNote | { error: string; code?: string }>
  delete(id: string): Promise<void | { error: string }>
  trash(): Promise<BrainNote[]>
  restore(id: string): Promise<BrainNote | { error: string }>
  purge(id: string): Promise<void | { error: string }>
  onChange(cb: (snapshot: { notes: BrainNote[] }) => void): () => void
}

export interface CanvasWidget {
  id: string
  title: string
  kind?: 'terminal' | 'note' | 'timer' | 'board' | 'planner' | 'files' | 'sys-monitor' | 'browser'
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  maximized?: boolean
  /** Stamped by the main process; echo it back on save so the merge can tell
   *  this window's own layout apart from a concurrent write. */
  version?: number
  updatedAt?: number
}

export interface CanvasPoint { x: number; y: number }

export interface CanvasStroke {
  id: string
  points: CanvasPoint[]
  color: string
}

export interface CanvasSnapshot {
  schemaVersion: number
  widgets: CanvasWidget[]
  camera: { x: number; y: number; zoom: number }
  strokes: CanvasStroke[]
  version: number
}

export interface CanvasApi {
  load(): Promise<CanvasSnapshot>
  onChange(cb: (snapshot: CanvasSnapshot) => void): () => void
  /**
   * Writes the window's live layout back. Merged, not replaced: a widget an
   * agent created or moved since this window last read the canvas survives.
   */
  save(snapshot: { widgets: CanvasWidget[]; camera: { x: number; y: number; zoom: number }; strokes: CanvasStroke[] }): Promise<
    { applied: number; skipped: number; removed: number } | { error: string }
  >
}

/** Repository status for the open project folder (main/git.ts). */
export interface GitStatus {
  repo: boolean
  root?: string
  branch?: string
  upstream?: string
  ahead: number
  behind: number
  modified: number
  untracked: number
  staged: number
  conflicted: number
  lastCommit?: { hash: string; subject: string; at: number }
  error?: string
  readAt: number
}

export interface GitApi {
  status(): Promise<GitStatus | { error: string }>
  /** Stages everything and commits; takes the `git:repo` lock on the way. */
  commit(message: string): Promise<{ hash: string } | { error: string }>
}

export interface FileEntry {
  name: string
  path: string
  isDirectory: boolean
  isFile: boolean
  isSymbolicLink: boolean
  size: number
  mtime: number
  ext: string
}

export interface FsListResult {
  currentPath: string
  parentPath: string | null
  items: FileEntry[]
  error?: string
}

export interface FileReadResult {
  path: string
  name: string
  content?: string
  dataUrl?: string | null
  isImage?: boolean
  isBinary?: boolean
  size: number
  mtime: number
  ext: string
  error?: string
}

export interface FsApi {
  list(dirPath?: string, options?: { showHidden?: boolean }): Promise<FsListResult | { error: string }>
  readFile(filePath: string, maxBytes?: number): Promise<FileReadResult | { error: string }>
  writeFile(filePath: string, content: string): Promise<{ ok: boolean; error?: string }>
  createFile(filePath: string): Promise<{ ok: boolean; error?: string }>
  createDir(dirPath: string): Promise<{ ok: boolean; error?: string }>
  delete(targetPath: string): Promise<{ ok: boolean; error?: string }>
  rename(oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }>
  reveal(targetPath: string): Promise<{ ok?: boolean; error?: string }>
  openPath(targetPath: string): Promise<{ ok?: boolean; error?: string }>
}

export interface SystemProcessMemory {
  rss: number
  heapUsed: number
  heapTotal: number
}

export interface SystemTerminalInfo {
  id: string
  title: string
  pid?: number
  running: boolean
  agentOwned?: boolean
}

/** Live write-path metrics from the CommandBus (see core/metrics.ts). */
export interface BusStats {
  counters: Record<string, number>
  gauges: Record<string, number>
  timings: Record<string, { count: number; avgMs: number; maxMs: number; lastMs: number }>
  queueDepth: number
  busyLanes: number
}

export interface SystemStats {
  cpuPercent: number
  cpuCount: number
  cpuModel: string
  cores?: number[]
  totalMem: number
  freeMem: number
  usedMem: number
  memUsagePercent: number
  processMemory: SystemProcessMemory
  uptime: number
  appUptime: number
  platform: string
  arch: string
  release: string
  hostname: string
  terminalsCount: number
  activeTerminals: SystemTerminalInfo[]
  nodeVersion: string
  electronVersion: string
  bus?: BusStats
  error?: string
}

export interface SystemApi {
  stats(): Promise<SystemStats | { error: string }>
}

export interface BrowserApi {
  onOpenTab(cb: (url: string) => void): () => void
}

export interface WindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
}