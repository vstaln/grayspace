import * as electron from 'electron'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import { basename, dirname, join } from 'path'
import { readStoreJson, sweepTempFiles, writeJsonAtomic } from './storage.ts'
import { normalizeTerminalNameList } from './terminalNames.ts'
import { getUserDataDir } from './userData.ts'
import { notifyCanvasWorkspaceChanged } from './canvasState.ts'
import { codeWorkspaceScope } from '../shared/codeWorkspace.ts'
import {
  readFolderWorkspaces,
  removeFolderSessions,
  writeFolderWorkspaces
} from './workspaceFolderStore.ts'

const safeStorage = (electron as unknown as { safeStorage?: typeof electron.safeStorage }).safeStorage


export type LinkSyntax = 'wiki' | 'dollar' | 'both'


export type WindowsShell = 'cmd' | 'powershell'
export type CommandPrefix = '/' | '.' | '@' | 'any'

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

export interface AppSettings {

  linkSyntax: LinkSyntax
  windowsShell: WindowsShell
  commandPrefix: CommandPrefix

  userName: string

  backgroundImage?: string

  backgroundDim: number

  backgroundBlur: number

  targetTerminalId?: string | null




  assistantModel?: string

  openRouterApiKey?: string
  openRouterApiKeyEnc?: string

  openRouterModel?: string
  aiProvider?: 'chatgpt' | 'claude' | 'grok'
  aiModel?: string
  aiReasoningEffort?: 'low' | 'medium' | 'high'
  aiConnectedProviders?: string[]
  localModel: LocalModelSettings

  favoriteWidgets?: string[]

  favoriteTerminalNames?: string[]
}

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

export type SettingsPatch = Partial<
  Omit<
    AppSettings,
    | 'backgroundImage'
    | 'commandPrefix'
    | 'targetTerminalId'
    | 'openRouterApiKey'
    | 'localModel'
  >
> & {
  backgroundImage?: string | null
  targetTerminalId?: string | null
  commandPrefix?: CommandPrefix
  openRouterApiKey?: string | null
  localModel?: Partial<LocalModelSettings>
}

export interface AppStateShape {
  workspaceDir?: string
  recent: RecentDir[]
  codeWorkspaceGroups: Record<string, CodeWorkspace[]>
  activeCodeWorkspaceIds: Record<string, string>
  lastActiveView?: 'canvas' | 'code'
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  linkSyntax: 'both',
  windowsShell: 'cmd',
  commandPrefix: 'any',
  userName: 'you',
  backgroundDim: 45,
  backgroundBlur: 40,
  localModel: {



    enabled: false,
    serverBin: '',
    modelPath: '',
    mmprojPath: '',
    contextSize: 32_768,
    gpuLayers: 99,
    idleTimeoutMs: 5 * 60_000,
    offloadVision: false
  },
  aiProvider: 'chatgpt',
  aiModel: 'gpt-5.6-sol',
  aiReasoningEffort: 'medium',
  aiConnectedProviders: [],
  favoriteWidgets: ['terminal', 'files', 'sys-monitor', 'timer', 'planner', 'orchestration', 'browser', 'links', 'music-player', 'chat'],
  favoriteTerminalNames: []
}

const MAX_RECENT = 12

const SECRET_MASK = '••••••••'


function encryptSecret(value: string): string | null {
  try {
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64')
    }
  } catch {

  }
  return null
}

function decryptSecret(encoded: string): string | null {
  try {
    if (safeStorage && typeof safeStorage.decryptString === 'function') {
      return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
    }
  } catch {
    return null
  }
  return null
}





export class AppState extends EventEmitter {
  private state: AppStateShape = {
    recent: [],
    codeWorkspaceGroups: {},
    activeCodeWorkspaceIds: {},
    settings: { ...DEFAULT_SETTINGS }
  }
  private loaded = false
  private get file(): string { return join(getUserDataDir(), 'workspace-state.json') }

  get(): AppStateShape {
    this.ensure()
    const settings = { ...this.state.settings } as AppSettings & { openRouterApiKeyEnc?: string; role?: unknown }
    delete settings.openRouterApiKeyEnc
    delete settings.role
    return {
      workspaceDir: this.state.workspaceDir,
      recent: this.sortedRecent(),
      codeWorkspaceGroups: { ...this.state.codeWorkspaceGroups },
      activeCodeWorkspaceIds: { ...this.state.activeCodeWorkspaceIds },
      lastActiveView: this.state.lastActiveView,
      settings
    }
  }

  get lastActiveView(): 'canvas' | 'code' | undefined {
    this.ensure()
    return this.state.lastActiveView
  }

  setLastActiveView(view: 'canvas' | 'code'): void {
    this.ensure()
    if (this.state.lastActiveView === view) return
    this.state.lastActiveView = view
    this.commit()
  }

  codeWorkspaceState(folder = this.workspaceDir): CodeWorkspaceState {
    this.ensure()
    const key = codeFolderKey(folder)
    this.adoptFolderWorkspaces(folder, key)
    const previousGroup = this.state.codeWorkspaceGroups[key]
    const previousActive = this.state.activeCodeWorkspaceIds[key]
    const workspaces = this.ensureCodeWorkspaceGroup(key)
    // Only the folder actually open gets a store seeded into it. The recent
    // list asks this for every folder it shows, and creating a directory
    // inside each of them would scatter `.orcspace-workspaces` across projects
    // the user has not opened in this session.
    if (folder && key === codeFolderKey(this.state.workspaceDir)) this.persistFolderWorkspaces(folder, key)
    if (previousGroup !== workspaces || previousActive !== this.state.activeCodeWorkspaceIds[key]) this.commitSoon()
    return { workspaces: workspaces.slice(), activeId: this.state.activeCodeWorkspaceIds[key], folder: folder ?? null }
  }

  activeCodeWorkspaceScope(folder = this.workspaceDir): string {
    const state = this.codeWorkspaceState(folder)
    return codeWorkspaceScope(folder, state.activeId)
  }

  createCodeWorkspace(folder: string | undefined, rawName?: string): CodeWorkspace | { error: string } {
    this.ensure()
    const key = codeFolderKey(folder)
    this.adoptFolderWorkspaces(folder, key)
    const workspaces = this.ensureCodeWorkspaceGroup(key)
    const name = (typeof rawName === 'string' ? rawName.trim() : '') || this.nextCodeWorkspaceName(workspaces)
    const validation = validateWorkspaceName(name)
    if (validation) return { error: validation }
    if (workspaces.some((workspace) => workspace.name.toLowerCase() === name.toLowerCase())) {
      return { error: 'A workspace with this name already exists.' }
    }
    const workspace = { id: `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name, createdAt: Date.now() }
    workspaces.push(workspace)
    this.state.activeCodeWorkspaceIds[key] = workspace.id
    this.commit()
    this.persistFolderWorkspaces(folder, key, true)
    return workspace
  }

  renameCodeWorkspace(folder: string | undefined, id: string, rawName: string): CodeWorkspaceState | { error: string } {
    this.ensure()
    this.adoptFolderWorkspaces(folder, codeFolderKey(folder))
    const workspaces = this.ensureCodeWorkspaceGroup(codeFolderKey(folder))
    const name = rawName.trim()
    const validation = validateWorkspaceName(name)
    if (validation) return { error: validation }
    const workspace = workspaces.find((item) => item.id === id)
    if (!workspace) return { error: 'Workspace not found.' }
    if (workspaces.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase())) {
      return { error: 'A workspace with this name already exists.' }
    }
    workspace.name = name
    this.commit()
    this.persistFolderWorkspaces(folder, codeFolderKey(folder), true)
    return this.codeWorkspaceState(folder)
  }

  deleteCodeWorkspace(folder: string | undefined, id: string): CodeWorkspaceState | { error: string } {
    this.ensure()
    const key = codeFolderKey(folder)
    this.adoptFolderWorkspaces(folder, key)
    const workspaces = this.ensureCodeWorkspaceGroup(key)
    const index = workspaces.findIndex((item) => item.id === id)
    if (index === -1) return { error: 'Workspace not found.' }
    const removed = workspaces[index]
    if (workspaces.length === 1) {
      delete this.state.codeWorkspaceGroups[key]
      delete this.state.activeCodeWorkspaceIds[key]
      this.commit()
      removeFolderSessions(folder, removed.id)
      // The folder keeps no workspaces of its own any more; leaving the file
      // behind would resurrect them the next time it is opened.
      this.persistFolderWorkspaces(folder, key, true)
      return { workspaces: [], activeId: '', folder: folder ?? null }
    }
    workspaces.splice(index, 1)
    if (!workspaces.some((item) => item.id === this.state.activeCodeWorkspaceIds[key])) {
      this.state.activeCodeWorkspaceIds[key] = workspaces[Math.max(0, index - 1)].id
    }
    this.commit()
    removeFolderSessions(folder, removed.id)
    this.persistFolderWorkspaces(folder, key, true)
    return this.codeWorkspaceState(folder)
  }

  setActiveCodeWorkspace(folder: string | undefined, id: string): CodeWorkspaceState | { error: string } {
    this.ensure()
    const key = codeFolderKey(folder)
    this.adoptFolderWorkspaces(folder, key)
    if (!this.ensureCodeWorkspaceGroup(key).some((workspace) => workspace.id === id)) return { error: 'Workspace not found.' }
    if (this.state.activeCodeWorkspaceIds[key] === id) return this.codeWorkspaceState(folder)
    this.state.activeCodeWorkspaceIds[key] = id
    this.commit()
    this.persistFolderWorkspaces(folder, key, true)
    return this.codeWorkspaceState(folder)
  }

  get workspaceDir(): string | undefined {
    this.ensure()
    return this.state.workspaceDir
  }

  get settings(): AppSettings {
    this.ensure()

    const {
      ...settings
    } = this.state.settings
    return settings
  }






  publicSettings(): AppSettings {
    const s = this.settings
    return {
      ...s,
      openRouterApiKey: s.openRouterApiKey ? SECRET_MASK : undefined
    }
  }


  setWorkspaceDir(dir: string | undefined): void {
    this.ensure()
    const nextDir = dir || undefined
    if (this.state.workspaceDir === nextDir) return
    this.state.workspaceDir = nextDir
    if (nextDir) {
      const existing = this.state.recent.find(r => r.path === nextDir)
      if (existing) existing.lastOpenedAt = Date.now()
      else this.state.recent.push({ path: nextDir, name: basename(nextDir) || nextDir, pinned: false, lastOpenedAt: Date.now() })
      this.trim()
    }
    this.commit()
    notifyCanvasWorkspaceChanged(nextDir)
  }

  togglePin(path: string): void {
    this.ensure()
    const entry = this.state.recent.find(r => r.path === path)
    if (entry) entry.pinned = !entry.pinned
    this.commit()
  }

  renameRecent(path: string, name: string): RecentDir[] | { error: string } {
    this.ensure()
    const clean = name.trim()
    if (!clean || clean.length > 80 || clean === '.' || clean === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(clean) || /[. ]$/.test(clean)) {
      return { error: 'Enter a valid workspace name.' }
    }
    const entry = this.state.recent.find((item) => item.path === path)
    if (!entry) return { error: 'Workspace not found.' }
    entry.name = clean
    this.commit()
    return this.sortedRecent()
  }

  removeRecent(path: string): void {
    this.ensure()
    this.state.recent = this.state.recent.filter(r => r.path !== path)
    this.commit()
  }


  patchSettings(patch: SettingsPatch): AppSettings {
    this.ensure()
    if (patch.windowsShell && ['cmd', 'powershell'].includes(patch.windowsShell)) {
      this.state.settings.windowsShell = patch.windowsShell
    }
    if (patch.commandPrefix && ['/', '.', '@', 'any'].includes(patch.commandPrefix)) {
      this.state.settings.commandPrefix = patch.commandPrefix
    }
    if (patch.linkSyntax && ['wiki', 'dollar', 'both'].includes(patch.linkSyntax))
      this.state.settings.linkSyntax = patch.linkSyntax
    if (typeof patch.assistantModel === 'string')
      this.state.settings.assistantModel = patch.assistantModel.trim().slice(0, 200) || undefined
    if (typeof patch.userName === 'string' && patch.userName.trim())
      this.state.settings.userName = patch.userName.trim().slice(0, 40)
    if ('backgroundImage' in patch)
      this.state.settings.backgroundImage = patch.backgroundImage || undefined
    if (typeof patch.backgroundDim === 'number' && Number.isFinite(patch.backgroundDim))
      this.state.settings.backgroundDim = Math.min(90, Math.max(0, Math.round(patch.backgroundDim)))
    if (typeof patch.backgroundBlur === 'number' && Number.isFinite(patch.backgroundBlur))
      this.state.settings.backgroundBlur = Math.min(90, Math.max(0, Math.round(patch.backgroundBlur)))
    if ('openRouterApiKey' in patch)
      this.setSecret('openRouterApiKey', 'openRouterApiKeyEnc', patch.openRouterApiKey)
    if (typeof patch.openRouterModel === 'string')
      this.state.settings.openRouterModel = patch.openRouterModel.trim().slice(0, 200) || undefined
    if (patch.aiProvider && ['chatgpt', 'claude', 'grok'].includes(patch.aiProvider))
      this.state.settings.aiProvider = patch.aiProvider
    if (typeof patch.aiModel === 'string')
      this.state.settings.aiModel = patch.aiModel.trim().slice(0, 200) || undefined
    if (patch.aiReasoningEffort && ['low', 'medium', 'high'].includes(patch.aiReasoningEffort))
      this.state.settings.aiReasoningEffort = patch.aiReasoningEffort
    if (Array.isArray(patch.aiConnectedProviders))
      this.state.settings.aiConnectedProviders = [...new Set(patch.aiConnectedProviders.filter((provider): provider is string => ['chatgpt', 'claude', 'grok'].includes(provider)))].slice(0, 3)
    if ('targetTerminalId' in patch) this.state.settings.targetTerminalId = cleanId(patch.targetTerminalId)
    if (patch.localModel && typeof patch.localModel === 'object') {




      const incoming = patch.localModel
      const merged = { ...this.state.settings.localModel }
      if (typeof incoming.enabled === 'boolean') merged.enabled = incoming.enabled
      for (const key of ['serverBin', 'modelPath', 'mmprojPath'] as const) {
        const value = (incoming as Record<string, unknown>)[key]
        if (value === undefined) continue
        merged[key] = typeof value === 'string' ? value.slice(0, 1024) : ''
      }
      const contextSize = (incoming as Record<string, unknown>).contextSize
      if (typeof contextSize === 'number' && Number.isFinite(contextSize)) {
        merged.contextSize = Math.min(1_000_000, Math.max(1024, Math.trunc(contextSize)))
      }
      const gpuLayers = (incoming as Record<string, unknown>).gpuLayers
      if (typeof gpuLayers === 'number' && Number.isFinite(gpuLayers)) {
        merged.gpuLayers = Math.min(999, Math.max(0, Math.trunc(gpuLayers)))
      }
      const idleTimeoutMs = (incoming as Record<string, unknown>).idleTimeoutMs
      if (typeof idleTimeoutMs === 'number' && Number.isFinite(idleTimeoutMs)) {
        merged.idleTimeoutMs = Math.min(3_600_000, Math.max(0, Math.trunc(idleTimeoutMs)))
      }
      if (typeof incoming.offloadVision === 'boolean') merged.offloadVision = incoming.offloadVision
      this.state.settings.localModel = merged
    }
    if (Array.isArray(patch.favoriteWidgets)) {
      const allowed = new Set(['terminal', 'timer', 'planner', 'orchestration', 'files', 'sys-monitor', 'browser', 'links', 'music-player', 'chat'])
      this.state.settings.favoriteWidgets = [...new Set(patch.favoriteWidgets.filter((kind): kind is string => typeof kind === 'string' && allowed.has(kind)))].slice(0, 32)
    }
    if (Array.isArray(patch.favoriteTerminalNames)) {
      this.state.settings.favoriteTerminalNames = normalizeTerminalNameList(patch.favoriteTerminalNames)
    }
    this.commit()
    return this.publicSettings()
  }


  private setSecret(
    plainKey: 'openRouterApiKey',
    encKey: 'openRouterApiKeyEnc',
    raw: string | null | undefined
  ): void {
    const value = raw?.trim() || undefined
    if (!value) {
      delete this.state.settings[plainKey]
      delete this.state.settings[encKey]
      this.deleteSecretBackups()
      return
    }

    if (value === SECRET_MASK || /^•+$/.test(value)) return
    const encrypted = encryptSecret(value)
    if (encrypted) {
      this.state.settings[encKey] = encrypted
      delete this.state.settings[plainKey]
    } else {

      this.state.settings[plainKey] = value
      delete this.state.settings[encKey]
    }
    this.deleteSecretBackups()
  }

  /**
   * Drop the rollback and quarantine copies of the state file.
   *
   * When OS encryption is unavailable the key lives in `settings` as plain
   * text, so `workspace-state.json.bak` and any `.corrupt-<ts>` quarantine
   * keep a readable copy of it. Revoking or re-encrypting the key has to take
   * those with it, or the old secret outlives the key it replaced. Losing the
   * rollback copy here is the cheaper failure: it is regenerated on the very
   * next commit.
   */
  private deleteSecretBackups(): void {
    try {
      fs.unlinkSync(`${this.file}.bak`)
    } catch {

    }
    let names: string[] = []
    try {
      names = fs.readdirSync(dirname(this.file))
    } catch {
      return
    }
    const base = basename(this.file)
    for (const name of names) {
      if (name.startsWith(`${base}.corrupt-`)) {
        try {
          fs.unlinkSync(join(dirname(this.file), name))
        } catch {

        }
      }
    }
  }


  private sortedRecent(): RecentDir[] {
    return this.state.recent
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt)
  }


  private trim(): void {
    const sorted = this.sortedRecent()
    const keep = new Set(sorted.slice(0, MAX_RECENT).map(r => r.path))
    this.state.recent = this.state.recent.filter(r => r.pinned || keep.has(r.path))
  }

  flush(): void {
    this.ensure()
    this.commit()
  }

  dispose(): void {
    if (this.commitTimer !== null) {
      // Flush synchronously: commitSoon() leaves a 400ms durability window
      // (autocreated workspace groups); quit inside the window must not drop it.
      this.commit()
    }
  }

  private ensure(): void {
    if (this.loaded) return




    try {
      sweepTempFiles(dirname(this.file))
    } catch {

    }
    const raw = readStoreJson<Partial<AppStateShape> & { codeWorkspaces?: unknown; activeCodeWorkspaceId?: unknown }>(this.file, {})
    const persistedSettings = { ...(raw.settings || {}) } as Record<string, unknown>
    delete persistedSettings.role
    this.loaded = true
    this.state = {
      workspaceDir: typeof raw.workspaceDir === 'string' ? raw.workspaceDir : undefined,
      recent: Array.isArray(raw.recent)
        ? raw.recent.filter(r => r && typeof r.path === 'string').map(r => ({
            path: r.path,
            name: r.name || basename(r.path) || r.path,
            pinned: Boolean(r.pinned),
            lastOpenedAt: Number(r.lastOpenedAt) || 0
          }))
        : [],
      codeWorkspaceGroups: normalizeCodeWorkspaceGroups(raw.codeWorkspaceGroups),
      activeCodeWorkspaceIds: normalizeActiveCodeWorkspaceIds(raw.activeCodeWorkspaceIds),
      settings: { ...DEFAULT_SETTINGS, ...persistedSettings }
    }


    const legacy = normalizeCodeWorkspaces(raw.codeWorkspaces)
    if (legacy.length) {
      const key = codeFolderKey(this.state.workspaceDir)
      if (!this.state.codeWorkspaceGroups[key]?.length) this.state.codeWorkspaceGroups[key] = legacy
      const legacyActive = typeof raw.activeCodeWorkspaceId === 'string' ? raw.activeCodeWorkspaceId : ''
      this.state.activeCodeWorkspaceIds[key] = legacy.some((workspace) => workspace.id === legacyActive) ? legacyActive : legacy[0].id
    }
    this.ensureCodeWorkspaceGroup(codeFolderKey(this.state.workspaceDir))



    this.state.settings.localModel = { ...DEFAULT_SETTINGS.localModel, ...(raw.settings?.localModel || {}) }
    if (!['cmd', 'powershell'].includes(this.state.settings.windowsShell))
      this.state.settings.windowsShell = DEFAULT_SETTINGS.windowsShell
    if (!['/', '.', '@', 'any'].includes(this.state.settings.commandPrefix))
      this.state.settings.commandPrefix = DEFAULT_SETTINGS.commandPrefix
    if (!['chatgpt', 'claude', 'grok'].includes(this.state.settings.aiProvider ?? ''))
      this.state.settings.aiProvider = DEFAULT_SETTINGS.aiProvider
    if (!['low', 'medium', 'high'].includes(this.state.settings.aiReasoningEffort ?? ''))
      this.state.settings.aiReasoningEffort = DEFAULT_SETTINGS.aiReasoningEffort
    if (typeof this.state.settings.aiModel !== 'string' || !this.state.settings.aiModel.trim())
      this.state.settings.aiModel = DEFAULT_SETTINGS.aiModel
    this.state.settings.aiConnectedProviders = Array.isArray(this.state.settings.aiConnectedProviders)
      ? [...new Set(this.state.settings.aiConnectedProviders.filter((provider): provider is string => ['chatgpt', 'claude', 'grok'].includes(provider)))].slice(0, 3)
      : []


    if (!Number.isFinite(this.state.settings.backgroundDim))
      this.state.settings.backgroundDim = DEFAULT_SETTINGS.backgroundDim
    if (!Number.isFinite(this.state.settings.backgroundBlur))
      this.state.settings.backgroundBlur = DEFAULT_SETTINGS.backgroundBlur
    this.state.settings.favoriteTerminalNames = normalizeTerminalNameList(this.state.settings.favoriteTerminalNames)


    this.decryptOrMigrate('openRouterApiKey', 'openRouterApiKeyEnc')
  }

  private decryptOrMigrate(
    plainKey: 'openRouterApiKey',
    encKey: 'openRouterApiKeyEnc'
  ): void {
    if (this.state.settings[encKey]) {
      this.state.settings[plainKey] = decryptSecret(this.state.settings[encKey] as string) || undefined
    } else if (this.state.settings[plainKey]) {
      const encrypted = encryptSecret(this.state.settings[plainKey] as string)
      if (encrypted) {
        this.state.settings[encKey] = encrypted
        delete this.state.settings[plainKey]
        this.commit()
      }
    }
  }

  private commitTimer: ReturnType<typeof setTimeout> | null = null

  /** Folders whose own store has already been read, and written, this session. */
  private folderWorkspacesRead = new Set<string>()
  private folderWorkspacesWritten = new Set<string>()

  private commit(): void {
    if (this.commitTimer !== null) {
      clearTimeout(this.commitTimer)
      this.commitTimer = null
    }
    try {
      writeJsonAtomic(this.file, { ...this.state, settings: this.settingsForDisk() })
    } catch (err) {



      console.error('failed to persist workspace state', err)
    }
    this.emit('change', this.get())
  }

  private commitSoon(): void {
    if (this.commitTimer !== null) return
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null
      this.commit()
    }, 400)
    this.commitTimer.unref?.()
    this.emit('change', this.get())
  }











  private settingsForDisk(): AppSettings {
    const settings = { ...this.state.settings }
    if (settings.openRouterApiKeyEnc) delete settings.openRouterApiKey
    return settings
  }

  private nextCodeWorkspaceName(workspaces: CodeWorkspace[]): string {
    const names = new Set(workspaces.map((workspace) => workspace.name.toLowerCase()))
    let index = 1
    while (names.has(`workspace ${index}`)) index += 1
    return `Workspace ${index}`
  }

  /**
   * What the folder itself records wins over what this machine remembered for
   * it: the folder may have been moved here, restored from a backup, or last
   * used by another install. Read once per folder per session — the app is the
   * only writer while it runs, so re-reading on every call would buy nothing.
   */
  private adoptFolderWorkspaces(folder: string | undefined, key: string): void {
    if (!folder || this.folderWorkspacesRead.has(key)) return
    this.folderWorkspacesRead.add(key)
    const carried = readFolderWorkspaces(folder)
    if (!carried) return
    this.state.codeWorkspaceGroups[key] = carried.workspaces.map((workspace) => ({ ...workspace }))
    this.state.activeCodeWorkspaceIds[key] = carried.activeId
    this.commitSoon()
  }

  /**
   * Mirrors a folder's workspaces back into it. `force` is for a change the
   * user just made; without it this only seeds a folder that carries nothing
   * yet, which is what migrates workspaces that predate the folder store.
   */
  private persistFolderWorkspaces(folder: string | undefined, key: string, force = false): void {
    if (!folder) return
    if (!force && this.folderWorkspacesWritten.has(key)) return
    const workspaces = this.state.codeWorkspaceGroups[key] ?? []
    const activeId = this.state.activeCodeWorkspaceIds[key] ?? workspaces[0]?.id ?? ''
    if (writeFolderWorkspaces(folder, workspaces, activeId)) this.folderWorkspacesWritten.add(key)
  }

  private ensureCodeWorkspaceGroup(key: string): CodeWorkspace[] {
    let workspaces = this.state.codeWorkspaceGroups[key]
    if (!Array.isArray(workspaces) || !workspaces.length) {
      workspaces = [{ id: `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: 'Workspace 1', createdAt: Date.now() }]
      this.state.codeWorkspaceGroups[key] = workspaces
    }
    const active = this.state.activeCodeWorkspaceIds[key]
    if (!workspaces.some((workspace) => workspace.id === active)) this.state.activeCodeWorkspaceIds[key] = workspaces[0].id
    return workspaces
  }
}

function validateWorkspaceName(name: string): string | null {
  if (!name || name.length > 80 || name === '.' || name === '..' || /[<>:"/\\|?*\u0000-\u001f]/.test(name) || /[. ]$/.test(name)) {
    return 'Enter a valid workspace name.'
  }
  return null
}

function normalizeCodeWorkspaces(raw: unknown): CodeWorkspace[] {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map((item) => ({
      id: typeof item.id === 'string' ? item.id.trim().slice(0, 128) : '',
      name: typeof item.name === 'string'
        ? item.name.trim().replace(/^WorkSpace (\d+)$/, 'Workspace $1').slice(0, 80)
        : '',
      createdAt: Number(item.createdAt) || Date.now()
    }))
    .filter((item) => Boolean(item.id) && Boolean(item.name))
}

function normalizeCodeWorkspaceGroups(raw: unknown): Record<string, CodeWorkspace[]> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const groups: Record<string, CodeWorkspace[]> = {}
  for (const [key, value] of Object.entries(raw)) {
    const workspaces = normalizeCodeWorkspaces(value)
    if (workspaces.length) groups[key] = workspaces
  }
  return groups
}

function normalizeActiveCodeWorkspaceIds(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value.trim()) result[key] = value.trim().slice(0, 128)
  }
  return result
}

function codeFolderKey(folder: string | undefined): string {
  return folder ? folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() : '__no-folder__'
}

function cleanId(value: unknown): string | undefined {
  const id = typeof value === 'string' ? value.trim().slice(0, 128) : ''
  return id || undefined
}
