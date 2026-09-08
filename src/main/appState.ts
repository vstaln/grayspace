import * as electron from 'electron'
import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage.ts'
import { getUserDataDir } from './userData.ts'
import { notifyCanvasWorkspaceChanged } from './canvasState.ts'

const safeStorage = (electron as unknown as { safeStorage?: typeof electron.safeStorage }).safeStorage


export type LinkSyntax = 'wiki' | 'dollar' | 'both'


export type WindowsShell = 'cmd' | 'powershell'

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

  missionMode: boolean
  linkSyntax: LinkSyntax
  windowsShell: WindowsShell

  userName: string

  backgroundImage?: string

  backgroundDim: number

  backgroundBlur: number

  targetTerminalId?: string




  assistantModel?: string

  openRouterApiKey?: string
  openRouterApiKeyEnc?: string

  openRouterModel?: string
  localModel: LocalModelSettings

  favoriteWidgets?: string[]
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
    | 'targetTerminalId'
    | 'openRouterApiKey'
    | 'localModel'
  >
> & {
  backgroundImage?: string | null
  targetTerminalId?: string | null
  openRouterApiKey?: string | null
  localModel?: Partial<LocalModelSettings>
}

export interface AppStateShape {
  workspaceDir?: string
  recent: RecentDir[]
  codeWorkspaceGroups: Record<string, CodeWorkspace[]>
  activeCodeWorkspaceIds: Record<string, string>
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  missionMode: false,
  linkSyntax: 'both',
  windowsShell: 'cmd',
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
  favoriteWidgets: ['terminal', 'files', 'sys-monitor', 'timer', 'planner', 'mission', 'orchestration', 'browser', 'links', 'music-player']
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
      settings
    }
  }

  codeWorkspaceState(folder = this.workspaceDir): CodeWorkspaceState {
    this.ensure()
    const key = codeFolderKey(folder)
    const previousGroup = this.state.codeWorkspaceGroups[key]
    const previousActive = this.state.activeCodeWorkspaceIds[key]
    const workspaces = this.ensureCodeWorkspaceGroup(key)
    if (previousGroup !== workspaces || previousActive !== this.state.activeCodeWorkspaceIds[key]) this.commit()
    return { workspaces: workspaces.slice(), activeId: this.state.activeCodeWorkspaceIds[key], folder: folder ?? null }
  }

  activeCodeWorkspaceScope(folder = this.workspaceDir): string {
    const state = this.codeWorkspaceState(folder)
    return `${codeFolderKey(folder)}\u0000${state.activeId}`
  }

  createCodeWorkspace(folder: string | undefined, rawName?: string): CodeWorkspace | { error: string } {
    this.ensure()
    const key = codeFolderKey(folder)
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
    return workspace
  }

  renameCodeWorkspace(folder: string | undefined, id: string, rawName: string): CodeWorkspaceState | { error: string } {
    this.ensure()
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
    return this.codeWorkspaceState(folder)
  }

  setActiveCodeWorkspace(folder: string | undefined, id: string): CodeWorkspaceState | { error: string } {
    this.ensure()
    const key = codeFolderKey(folder)
    if (!this.ensureCodeWorkspaceGroup(key).some((workspace) => workspace.id === id)) return { error: 'Workspace not found.' }
    if (this.state.activeCodeWorkspaceIds[key] === id) return this.codeWorkspaceState(folder)
    this.state.activeCodeWorkspaceIds[key] = id
    this.commit()
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
    if (typeof patch.missionMode === 'boolean') this.state.settings.missionMode = patch.missionMode
    if (patch.windowsShell && ['cmd', 'powershell'].includes(patch.windowsShell)) {
      this.state.settings.windowsShell = patch.windowsShell
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
      const allowed = new Set(['terminal', 'timer', 'planner', 'mission', 'orchestration', 'files', 'sys-monitor', 'browser', 'links', 'music-player'])
      this.state.settings.favoriteWidgets = [...new Set(patch.favoriteWidgets.filter((kind): kind is string => typeof kind === 'string' && allowed.has(kind)))].slice(0, 32)
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

  private ensure(): void {
    if (this.loaded) return




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
    if (typeof this.state.settings.missionMode !== 'boolean')
      this.state.settings.missionMode = DEFAULT_SETTINGS.missionMode


    if (!Number.isFinite(this.state.settings.backgroundDim))
      this.state.settings.backgroundDim = DEFAULT_SETTINGS.backgroundDim
    if (!Number.isFinite(this.state.settings.backgroundBlur))
      this.state.settings.backgroundBlur = DEFAULT_SETTINGS.backgroundBlur


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

  private commit(): void {
    try {
      writeJsonAtomic(this.file, { ...this.state, settings: this.settingsForDisk() })
    } catch (err) {



      console.error('failed to persist workspace state', err)
    }
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
    return `WorkSpace ${index}`
  }

  private ensureCodeWorkspaceGroup(key: string): CodeWorkspace[] {
    let workspaces = this.state.codeWorkspaceGroups[key]
    if (!Array.isArray(workspaces) || !workspaces.length) {
      workspaces = [{ id: `code-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, name: 'WorkSpace 1', createdAt: Date.now() }]
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
      name: typeof item.name === 'string' ? item.name.trim().slice(0, 80) : '',
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
