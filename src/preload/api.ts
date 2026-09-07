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
  setTitle?(id: string, title: string): Promise<{ ok: boolean; error?: string }>
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
  onAddWidget(cb: (payload: { id: string; title: string; kind?: string; x?: number; y?: number; from?: string | null }) => void): () => void
  onRemoveWidget(cb: (id: string) => void): () => void
  onRenameWidget(cb: (payload: { id: string; title: string }) => void): () => void
}

export interface RecentDir {
  path: string
  name: string
  pinned: boolean
  lastOpenedAt: number
}

export interface CodeWorkspace {
  id: string
  name: string
  createdAt: number
}

export interface CodeWorkspaceState {
  workspaces: CodeWorkspace[]
  activeId: string
  folder: string | null
}

export interface WorkspaceApi {
  getDir(): Promise<string | null>
  pickDir(): Promise<string | null>
  /** Creates a new logical workspace with its own private working folder. */
  create(name: string): Promise<string | { error: string } | null>
  rename(path: string, name: string): Promise<RecentDir[] | { error: string }>
  codeWorkspaces(): Promise<CodeWorkspaceState>
  createCodeWorkspace(name?: string): Promise<CodeWorkspace | { error: string }>
  renameCodeWorkspace(id: string, name: string): Promise<CodeWorkspaceState | { error: string }>
  selectCodeWorkspace(id: string): Promise<CodeWorkspaceState | { error: string }>
  onCodeWorkspaceChange(cb: (state: CodeWorkspaceState) => void): () => void
  onDirChange(cb: (dir: string | null) => void): () => void
  recent(): Promise<RecentDir[]>
  openRecent(path: string): Promise<string | { error: string }>
  pinRecent(path: string): Promise<RecentDir[]>
  forgetRecent(path: string): Promise<RecentDir[]>
  onRecentChange(cb: (recent: RecentDir[]) => void): () => void
}

export type LinkSyntax = 'wiki' | 'dollar' | 'both'
export type UserRole = 'member' | 'lead'

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
  windowsShell: 'cmd' | 'powershell'
  role: UserRole
  userName: string
  backgroundImage?: string
  /** 0–90 % black laid over the wallpaper. */
  backgroundDim: number
  /** 0–90 % blur applied to the wallpaper. */
  backgroundBlur: number
  /** Model the built-in assistant plans with. */
  assistantModel?: string
  /** Masked OpenRouter API key; plaintext stays in the main process. */
  openRouterApiKey?: string
  openRouterModel?: string
  localModel: LocalModelSettings
  favoriteWidgets?: string[]
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
      openRouterApiKey?: string | null
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

/** A picture copied into the app's own store, addressable by absolute path. */
export interface MediaFile { name: string; path: string }

export interface MediaApi {
  /** Saves the clipboard bitmap, or null when the clipboard holds no image. */
  saveClipboard(): Promise<MediaFile | null>
  /**
   * Same bitmap, written to the OS temp dir instead of the durable store — for
   * a paste whose only job is to hand a path to a command (terminals).
   */
  saveClipboardScratch(): Promise<MediaFile | null>
  saveBytes(bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null>
  /** saveBytes' throwaway twin, for the same terminal-paste case. */
  saveBytesScratch(bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null>
  /** Reads an image back as a data URL; null when missing or not an image. */
  dataUrl(path: string): Promise<string | null>
  /**
   * Resolves a dropped `File`'s real filesystem path — sandbox +
   * contextIsolation strip `File.path` in the renderer, so a drag-and-drop of
   * a screenshot (or any file) onto a terminal needs this to hand the shell a
   * usable path instead of an opaque in-memory blob.
   */
  getPathForFile(file: File): string
}

// ---- orchestration ---------------------------------------------------------

/**
 * The fleet, as the window sees it. Agents drive all of this through the `orc`
 * CLI; the window mirrors it and owns the few decisions only a human can make.
 */
export type OrcTaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
export type OrcMessageType =
  | 'dispatch'
  | 'worker_done'
  | 'heartbeat'
  | 'escalation'
  | 'ask'
  | 'reply'
  | 'note'
export type OrcOutcome = 'succeeded' | 'failed'
export type OrcDispatchState = 'running' | 'settled' | 'retained' | 'released'

export interface OrcRun {
  id: string
  objective: string
  coordinator: string
  createdAt: number
  closedAt?: number
  version: number
}

export interface OrcTask {
  id: string
  runId: string
  title: string
  spec: string
  deps: string[]
  status: OrcTaskStatus
  createdBy: string
  createdAt: number
  updatedAt: number
  outcome?: OrcOutcome
  version: number
}

export interface OrcDispatch {
  id: string
  runId: string
  taskId: string
  terminalId: string
  agent: string
  state: OrcDispatchState
  outcome?: OrcOutcome
  preamble: string
  startedAt: number
  settledAt?: number
  filesModified?: string[]
  version: number
}

export interface OrcMessage {
  id: string
  runId: string
  type: OrcMessageType
  from: string
  to: string
  subject: string
  body: string
  taskId?: string
  dispatchId?: string
  outcome?: OrcOutcome
  filesModified?: string[]
  options?: string[]
  replyTo?: string
  createdAt: number
  ackedBy: string[]
}

export interface OrcGate {
  id: string
  runId: string
  taskId?: string
  question: string
  options: string[]
  createdBy: string
  resolution?: string
  createdAt: number
  resolvedAt?: number
  version: number
}

export interface OrcSnapshot {
  runs: OrcRun[]
  tasks: OrcTask[]
  dispatches: OrcDispatch[]
  messages: OrcMessage[]
  gates: OrcGate[]
}

export interface OrchestrationApi {
  snapshot(runId?: string): Promise<OrcSnapshot>
  /** Reads the run's mail without consuming it — acking is the agent's job. */
  inbox(runId?: string): Promise<OrcMessage[]>
  /** Answers a worker that is blocked on `orc ask`. */
  reply(askId: string, body: string): Promise<unknown>
  resolveGate(gateId: string, resolution: string): Promise<unknown>
  /** Accounts for a settled worker: keep its terminal, or hand it back. */
  account(dispatchId: string, state: 'retained' | 'released', closeTerminal?: boolean): Promise<unknown>
  closeRun(runId: string): Promise<unknown>
  onChange(cb: () => void): () => void
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
  /** Absolute paths to attached photos (media store). */
  attachments?: string[]
}

export interface PlannerApi {
  list(): Promise<PlanItem[]>
  create(input: {
    title: string
    note?: string
    project?: string
    day?: string
    time?: string
    attachments?: string[]
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
      attachments?: string[] | null
      baseVersion?: number
    }
  ): Promise<PlanItem | { error: string }>
  /** Check / uncheck. Omit `done` to flip. */
  toggle(id: string, done?: boolean, baseVersion?: number): Promise<PlanItem | { error: string }>
  delete(id: string): Promise<void | { error: string }>
  onChange(cb: (items: PlanItem[]) => void): () => void
}



export interface CanvasWidget {
  id: string
  title: string
  kind?: 'terminal' | 'timer' | 'board' | 'planner' | 'files' | 'sys-monitor' | 'browser' | 'links' | 'music-player' | 'orchestration'
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

export interface CodeSession {
  id: string
  agentId: string
  label: string
  command: string
  title?: string
  status?: 'active' | 'finished'
}

export type WorkView = 'canvas' | 'code' | 'chat'

export interface CodeSnapshot {
  schemaVersion: number
  sessions: CodeSession[]
  featuredId: string | null
  maximizedId: string | null
  activeView?: WorkView | null
  version: number
}

export interface CodeApi {
  load(): Promise<CodeSnapshot>
  save(snapshot: { sessions?: CodeSession[]; featuredId?: string | null; maximizedId?: string | null; activeView?: WorkView | null; workspaceDir?: string | null; codeWorkspaceId?: string }): Promise<{ ok: boolean } | { error: string }>
  onChange(cb: (snapshot: CodeSnapshot) => void): () => void
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

export interface AgentUsageWindow {
  percent: number
  remainingPercent?: number
  usedPercent?: number
  requests: number
  tokens?: number
  limit: number
  resetInfo?: string
  resetAt?: number
  refreshesIn?: string
}

export interface AgentUsageItem {
  id: string
  name: string
  command: string
  isOpen: boolean
  openCount: number
  fiveHour: AgentUsageWindow
  weekly: AgentUsageWindow
  monthly?: AgentUsageWindow
  lastActiveAt?: number
  hasExactQuota?: boolean
  accountEmail?: string
  modelName?: string
  tierName?: string
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
  agents?: AgentUsageItem[]
  error?: string
}

export interface SystemApi {
  stats(): Promise<SystemStats | { error: string }>
  onPersistError(cb: (payload: { store: string; message: string; at: number }) => void): () => void
}

export interface BrowserApi {
  onOpenTab(cb: (url: string) => void): () => void
  clearData(): Promise<{ ok: boolean; error?: string }>
}

export interface WindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
}

export type ChatModelId = 'codex' | 'claude' | 'grok' | 'antigravity' | 'opencode'

export type ChatEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'ultra'

export interface ChatSendOptions {
  model?: string
  effort?: ChatEffort
  images?: string[]
}

export interface ChatModelOption {
  id: string
  label: string
  efforts?: ChatEffort[]
}

export type ChatModelCatalog = Partial<Record<ChatModelId, { models: ChatModelOption[]; defaultModel?: string; defaultEffort?: ChatEffort }>>

export interface ChatExitPayload {
  exitCode: number
  cancelled?: boolean
  timedOut?: boolean
}

export interface ChatApi {
  send(threadId: string, model: ChatModelId, prompt: string, options?: ChatSendOptions): Promise<{ ok: true } | { error: string }>
  listModels(): Promise<ChatModelCatalog>
  stop(threadId: string): Promise<{ ok: boolean }>
  dispose(threadId: string): Promise<{ ok: boolean }>
  onData(cb: (threadId: string, chunk: string) => void): () => void
  onExit(cb: (threadId: string, payload: ChatExitPayload) => void): () => void
}
