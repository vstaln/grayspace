





export interface TerminalApi {
  list(): Promise<Array<{ id: string; title: string; cwd: string }>>
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




  detach(id: string): void

  setFocused(focused: boolean, id: string): void
  onData(id: string, cb: (data: string) => void): () => void
  onExit(id: string, cb: (exitCode: number) => void): () => void
  onBackendError(cb: (message: string) => void): () => void
}

export interface ControlApi {
  onAddWidget(cb: (payload: { id: string; title: string; kind?: string; x?: number; y?: number; from?: string | null }) => void): () => void
  onRemoveWidget(cb: (id: string) => void): () => void
  onRenameWidget(cb: (payload: { id: string; title: string }) => void): () => void

  onOpenMedia(
    cb: (payload: { widgetId: string; path: string; name: string; mediaUrl: string; kind: string }) => void
  ): () => void
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

export interface CodeWorkspaceGroup extends CodeWorkspaceState {
  folder: string
  name: string
}

export interface WorkspaceApi {
  getDir(): Promise<string | null>
  pickDir(): Promise<string | null>

  create(name: string): Promise<string | { error: string } | null>
  rename(path: string, name: string): Promise<RecentDir[] | { error: string }>
  codeWorkspaces(): Promise<CodeWorkspaceState>
  codeWorkspaceGroups(): Promise<CodeWorkspaceGroup[]>
  createCodeWorkspace(name?: string, folder?: string): Promise<CodeWorkspace | { error: string }>
  renameCodeWorkspace(id: string, name: string, folder?: string): Promise<CodeWorkspaceState | { error: string }>
  deleteCodeWorkspace(id: string, folder?: string): Promise<CodeWorkspaceState | { error: string }>
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
export type CommandPrefix = '/' | '.' | '@' | 'any'
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
  commandPrefix: CommandPrefix
  targetTerminalId?: string | null
  userName: string
  backgroundImage?: string

  backgroundDim: number

  backgroundBlur: number

  assistantModel?: string

  openRouterApiKey?: string
  openRouterModel?: string
  aiProvider?: 'chatgpt' | 'claude' | 'grok'
  aiModel?: string
  aiReasoningEffort?: 'low' | 'medium' | 'high'
  aiConnectedProviders?: string[]
  localModel: LocalModelSettings
  favoriteWidgets?: string[]
  favoriteTerminalNames?: string[]
}

export interface AppUpdateState {
  status: 'idle' | 'disabled' | 'checking' | 'current' | 'downloading' | 'ready' | 'installing' | 'error'
  currentVersion: string
  version?: string
  percent?: number
  message?: string
}

export interface SettingsApi {
  updateState(): Promise<AppUpdateState>
  checkUpdates(): Promise<AppUpdateState>
  installUpdate(): Promise<boolean>
  get(): Promise<AppSettings>
  set(
    patch: Partial<
      Omit<
        AppSettings,
        | 'backgroundImage'
        | 'commandPrefix'
        | 'targetTerminalId'
        | 'localModel'
      >
    > & {
      backgroundImage?: string | null
      commandPrefix?: CommandPrefix
      targetTerminalId?: string | null
      openRouterApiKey?: string | null
      localModel?: Partial<LocalModelSettings>
    }
  ): Promise<AppSettings>

  getBackground(): Promise<string | null>
  pickBackground(): Promise<{ dataUrl?: string | null; error?: string }>
  clearBackground(): Promise<null>
  onChange(cb: (settings: AppSettings) => void): () => void
}

export type ChatProvider = 'chatgpt' | 'claude' | 'grok'
export type ChatReasoningEffort = 'low' | 'medium' | 'high'

export interface ChatMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: number
}

export interface ChatRequest {
  widgetId: string
  workspaceDir?: string | null
  provider: ChatProvider
  model: string
  reasoningEffort: ChatReasoningEffort
  message: string
  history: ChatMessage[]
}

export interface ChatEvent {
  widgetId: string
  requestId: string
  type: 'status' | 'complete' | 'error'
  text?: string
  provider?: ChatProvider
}

export interface ChatProviderStatus {
  id: ChatProvider
  label: string
  available?: boolean
  connected: boolean
  connecting?: boolean
  detail: string
  installCommand?: string
}

export interface ChatAuthEvent {
  provider: ChatProvider
  type: 'started' | 'instructions' | 'complete' | 'error'
  message: string
  url?: string
  userCode?: string
  requiresInput?: boolean
}

export interface ChatApi {
  providers(): Promise<ChatProviderStatus[]>
  connect(provider: ChatProvider): Promise<{ ok: boolean; error?: string }>
  submitAuthCode(provider: ChatProvider, code: string): Promise<{ ok: boolean; error?: string }>
  send(request: ChatRequest): Promise<{ ok: boolean; requestId?: string; error?: string }>
  cancel(widgetId: string): Promise<{ ok: boolean }>
  onEvent(cb: (event: ChatEvent) => void): () => void
  onAuthEvent(cb: (event: ChatAuthEvent) => void): () => void
}


export interface MediaFile { name: string; path: string }

export interface MediaApi {

  saveClipboard(): Promise<MediaFile | null>
  readClipboardText(): Promise<string>
  writeClipboardText?(text: string): Promise<{ ok: true } | { error: string }>




  saveClipboardScratch(): Promise<MediaFile | null>
  stageClipboardImage(bytes: Uint8Array): Promise<{ ok: true } | { error: string }>
  saveBytes(bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null>

  saveBytesScratch(bytes: Uint8Array, ext: string): Promise<MediaFile | { error: string } | null>

  dataUrl(path: string): Promise<string | null>






  getPathForFile(file: File): string
}







export type OrcTaskStatus = 'pending' | 'ready' | 'dispatched' | 'completed' | 'failed' | 'blocked'
export type OrcMessageType =
  | 'dispatch'
  | 'worker_done'
  | 'heartbeat'
  | 'escalation'
  | 'ask'
  | 'permission'
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
  images?: string[]
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
  images?: string[]
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

  inbox(runId?: string): Promise<OrcMessage[]>

  reply(askId: string, body: string): Promise<unknown>

  respondToPermission(askId: string, approved: boolean, note?: string): Promise<unknown>
  resolveGate(gateId: string, resolution: string): Promise<unknown>

  account(dispatchId: string, state: 'retained' | 'released', closeTerminal?: boolean): Promise<unknown>
  closeRun(runId: string): Promise<unknown>
  onChange(cb: () => void): () => void
}






export interface PlanItem {
  id: string
  title: string
  note: string

  project?: string

  day?: string

  time?: string
  done: boolean
  createdBy: string
  order: number
  createdAt: number
  updatedAt: number
  version: number

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

  toggle(id: string, done?: boolean, baseVersion?: number): Promise<PlanItem | { error: string }>
  delete(id: string): Promise<void | { error: string }>
  onChange(cb: (items: PlanItem[]) => void): () => void
}



export interface CanvasWidget {
  id: string
  title: string
  kind?: 'terminal' | 'timer' | 'planner' | 'files' | 'sys-monitor' | 'browser' | 'links' | 'music-player' | 'orchestration' | 'chat'
  x: number
  y: number
  w: number
  h: number
  z: number
  maximized?: boolean


  version?: number
  updatedAt?: number
}

export interface CanvasPoint { x: number; y: number }

export interface CanvasStroke {
  id: string
  points: CanvasPoint[]
  color: string
}

export interface CanvasConnection {
  id: string
  from: string
  to: string
  bornAt: number
}

export interface CanvasSnapshot {
  schemaVersion: number
  widgets: CanvasWidget[]
  camera: { x: number; y: number; zoom: number }
  strokes: CanvasStroke[]
  connections: CanvasConnection[]
  version: number
}

export interface CanvasApi {
  load(): Promise<CanvasSnapshot>
  onChange(cb: (snapshot: CanvasSnapshot) => void): () => void




  save(snapshot: { widgets: CanvasWidget[]; camera: { x: number; y: number; zoom: number }; strokes: CanvasStroke[]; connections: CanvasConnection[] }): Promise<
    { applied: number; skipped: number; removed: number } | { ok: true; discarded: true } | { error: string }
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

export type WorkView = 'canvas' | 'code'

export interface CodeSnapshot {
  schemaVersion: number
  sessions: CodeSession[]
  featuredId: string | null
  maximizedId: string | null
  activeView?: WorkView | null
  version: number
}

export interface AgentConversation {
  id: string
  agentId: 'claude' | 'codex' | 'antigravity' | 'grok'
  title: string
  updatedAt: number
  command: string
}

export interface CodeApi {
  load(): Promise<CodeSnapshot>
  conversations(dir?: string): Promise<AgentConversation[]>
  save(snapshot: { sessions?: CodeSession[]; featuredId?: string | null; maximizedId?: string | null; activeView?: WorkView | null; workspaceDir?: string | null; codeWorkspaceId?: string }): Promise<{ ok: boolean; snapshot?: CodeSnapshot; discarded?: boolean } | { error: string }>
  saveSync?(snapshot: { sessions?: CodeSession[]; featuredId?: string | null; maximizedId?: string | null; activeView?: WorkView | null; workspaceDir?: string | null; codeWorkspaceId?: string }): { ok: boolean } | { error: string }
  onChange(cb: (snapshot: CodeSnapshot) => void): () => void
}


export interface GitBranch {
  name: string
  current: boolean
}

export interface GitCommit {
  hash: string
  short: string
  subject: string
  author: string
  at: number
  refs: string[]
}

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

  commit(message: string): Promise<{ hash: string } | { error: string }>
  branches(): Promise<{ branches: GitBranch[]; current: string } | { error: string }>
  log(options?: { limit?: number; query?: string }): Promise<{ commits: GitCommit[]; head: string } | { error: string }>
  checkout(ref: string): Promise<{ branch: string; hash: string } | { error: string }>
  createBranch(name: string, startPoint?: string): Promise<{ branch: string; hash: string } | { error: string }>
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
  /** True when the folder has more entries than were returned; see FilesWidget. */
  truncated?: boolean
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


export interface FlowStats {
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
  flow?: FlowStats
  agents?: AgentUsageItem[]
  error?: string
}

export interface SystemApi {
  stats(): Promise<SystemStats | { error: string }>
  releaseLocks(): Promise<{ ok: boolean } | { error: string }>
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
