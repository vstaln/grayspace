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
  create(id: string, cols?: number, rows?: number): Promise<{ ok: boolean; error?: string }>
  write(id: string, data: string): void
  resize(id: string, cols: number, rows: number): void
  dispose(id: string): void
  /** Reports whether this terminal widget currently holds keyboard focus. */
  setFocused(focused: boolean, id: string): void
  onData(id: string, cb: (data: string) => void): () => void
  onExit(id: string, cb: (exitCode: number) => void): () => void
}

export interface ControlApi {
  onAddWidget(cb: (payload: { id: string; title: string }) => void): () => void
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
export interface AppSettings {
  linkSyntax: LinkSyntax
  role: UserRole
  userName: string
  backgroundImage?: string
  /** 0–90 % black laid over the wallpaper. */
  backgroundDim: number
  /** Key for the free-tier OpenRouter models in the chat panel. */
  openRouterApiKey?: string
  /** Model the built-in assistant plans with. */
  assistantModel?: string
}

export interface SettingsApi {
  get(): Promise<AppSettings>
  set(
    patch: Partial<Omit<AppSettings, 'backgroundImage' | 'openRouterApiKey'>> & {
      backgroundImage?: string | null
      openRouterApiKey?: string | null
    }
  ): Promise<AppSettings>
  /** The stored wallpaper as a data URL, or null when none is set. */
  getBackground(): Promise<string | null>
  pickBackground(): Promise<{ dataUrl?: string | null; error?: string }>
  clearBackground(): Promise<null>
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
    }
  ): Promise<Task | { error: string }>
  deleteTask(id: string): Promise<void | { error: string }>
  resetManager(): Promise<CoordinationSnapshot>
  releaseLocks(): Promise<CoordinationSnapshot>
  onChange(cb: (snapshot: CoordinationSnapshot) => void): () => void
}

/** One entry of the live OpenRouter catalog (see main/openrouterModels.ts). */
export interface CatalogModel {
  id: string
  label: string
  free: boolean
  contextLength: number
}

export interface ChatApi {
  send(request: { id: string; provider: 'claude' | 'codex' | 'opencode' | 'openrouter'; prompt: string; model: string; effort: 'low' | 'medium' | 'high'; mode: 'fast' | 'build' | 'plan' }): Promise<{ ok: boolean; error?: string }>
  cancel(id: string): void
  /** Live model list; `force` skips the 30-minute cache. */
  models(force?: boolean): Promise<CatalogModel[]>
  onEvent(cb: (event: { id: string; type: 'delta' | 'done' | 'error'; text?: string; error?: string; tokens?: string }) => void): () => void
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

export interface GraphNode { id: string; title: string; tags: string[]; degree: number; color?: string }
export interface GraphEdge { source: string; target: string; kind: 'link' | 'tag' }
export interface BrainGraph { nodes: GraphNode[]; edges: GraphEdge[] }

export interface BrainApi {
  list(): Promise<{ notes: BrainNote[] }>
  create(input: Partial<BrainNote>): Promise<BrainNote>
  update(id: string, patch: Partial<BrainNote>): Promise<BrainNote>
  delete(id: string): Promise<void>
  trash(): Promise<BrainNote[]>
  restore(id: string): Promise<BrainNote>
  purge(id: string): Promise<void>
  graph(): Promise<BrainGraph>
}

export interface CanvasWidget {
  id: string
  title: string
  kind?: 'terminal' | 'note' | 'git-status' | 'timer' | 'schedule' | 'board'
  noteId?: string
  x: number
  y: number
  w: number
  h: number
  z: number
  minimized?: boolean
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
  /**
   * Writes the window's live layout back. Merged, not replaced: a widget an
   * agent created or moved since this window last read the canvas survives.
   */
  save(snapshot: { widgets: CanvasWidget[]; camera: { x: number; y: number; zoom: number }; strokes: CanvasStroke[] }): Promise<
    { applied: number; skipped: number; removed: number } | { error: string }
  >
}

// ---- the built-in assistant ------------------------------------------------

export type RunStatus = 'running' | 'waiting_human' | 'done' | 'failed'

export interface PlanStep {
  command: string
  target: string
  payload: unknown
  summary: string
  needsApproval?: boolean
}

export interface RunState {
  runId: string
  goal: string
  actorId: string
  step: number
  status: RunStatus
  currentNode: string
  plan: PlanStep[]
  cursor: number
  held: string[]
  scratch: Record<string, unknown>
  log: string[]
  question?: string
  error?: string
  startedAt: number
  updatedAt: number
}

export interface AssistantApi {
  /** Resolves when the run finishes or parks at the human gate. */
  start(goal: string): Promise<RunState | { error: string }>
  answer(runId: string, approved: boolean, note?: string): Promise<RunState | null>
  cancel(runId: string): Promise<RunState | null>
  runs(): Promise<RunState[]>
  onRun(cb: (run: RunState) => void): () => void
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

export interface WindowApi {
  minimize(): void
  toggleMaximize(): void
  close(): void
  isMaximized(): Promise<boolean>
  onMaximizeChange(cb: (maximized: boolean) => void): () => void
}

declare global {
  interface Window {
    api: {
      terminal: TerminalApi
      control: ControlApi
      workspace: WorkspaceApi
      settings: SettingsApi
      media: MediaApi
      coordination: CoordinationApi
      chat: ChatApi
      brain: BrainApi
      canvas: CanvasApi
      assistant: AssistantApi
      git: GitApi
      window: WindowApi
    }
  }
}

export {}
