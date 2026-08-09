import { app, safeStorage } from 'electron'
import { EventEmitter } from 'events'
import { basename, join } from 'path'
import { readStoreJson, writeJsonAtomic } from './storage'

/** How a note body addresses another note. Switchable from the settings menu. */
export type LinkSyntax = 'wiki' | 'dollar' | 'both'

/** `lead` sees and edits the whole board; `member` works inside their own tasks. */
export type UserRole = 'member' | 'lead'

export interface RecentDir {
  path: string
  name: string
  /** Pinned folders stay in the rail regardless of how long ago they were opened. */
  pinned: boolean
  lastOpenedAt: number
}

export interface AppSettings {
  linkSyntax: LinkSyntax
  role: UserRole
  /** Shown as the assignee on kanban cards the human takes. */
  userName: string
  /** Absolute path of the wallpaper copied into userData; unset means no photo yet. */
  backgroundImage?: string
  /** 0–90 % of black laid over the wallpaper so widgets stay readable on bright photos. */
  backgroundDim: number
  /** Key for the free-tier OpenRouter models in the chat panel; unset until the user pastes one. */
  openRouterApiKey?: string
  /** Encrypted form of `openRouterApiKey` on disk (safeStorage); never sent to the renderer. */
  openRouterApiKeyEnc?: string
  /**
   * Model the built-in assistant plans with. Separate from whatever the chat
   * panel is set to: a chat turn and an autonomous run have different needs,
   * and silently repurposing the chat model would surprise the user the first
   * time a cheap chat model produced a bad plan.
   */
  assistantModel?: string
}

export type SettingsPatch = Partial<Omit<AppSettings, 'backgroundImage' | 'openRouterApiKey'>> & {
  backgroundImage?: string | null
  openRouterApiKey?: string | null
}

export interface AppStateShape {
  workspaceDir?: string
  recent: RecentDir[]
  settings: AppSettings
}

const DEFAULT_SETTINGS: AppSettings = {
  linkSyntax: 'both',
  role: 'member',
  userName: 'you',
  backgroundDim: 45
}
const MAX_RECENT = 12

/** Best-effort secret encryption; returns null when the platform has no keychain. */
function encryptSecret(value: string): string | null {
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return safeStorage.encryptString(value).toString('base64')
    }
  } catch {
    /* fall back to plaintext below */
  }
  return null
}

function decryptSecret(encoded: string): string | null {
  try {
    return safeStorage.decryptString(Buffer.from(encoded, 'base64'))
  } catch {
    return null
  }
}

/**
 * Persisted desktop state: the active project folder, the folders opened before
 * it, and user settings. Emits `change` so the renderer can mirror it live.
 */
export class AppState extends EventEmitter {
  private state: AppStateShape = { recent: [], settings: { ...DEFAULT_SETTINGS } }
  private loaded = false
  private get file(): string { return join(app.getPath('userData'), 'workspace-state.json') }

  get(): AppStateShape {
    this.ensure()
    const { openRouterApiKeyEnc: _enc, ...settings } = this.state.settings
    return {
      workspaceDir: this.state.workspaceDir,
      recent: this.sortedRecent(),
      settings
    }
  }

  get workspaceDir(): string | undefined {
    this.ensure()
    return this.state.workspaceDir
  }

  get settings(): AppSettings {
    this.ensure()
    // Ciphertext is internal to this class; callers only ever see the key.
    const { openRouterApiKeyEnc: _enc, ...settings } = this.state.settings
    return settings
  }

  /** Switching folders records the previous choice so it can be reopened in one click. */
  setWorkspaceDir(dir: string | undefined): void {
    this.ensure()
    this.state.workspaceDir = dir || undefined
    if (dir) {
      const existing = this.state.recent.find(r => r.path === dir)
      if (existing) existing.lastOpenedAt = Date.now()
      else this.state.recent.push({ path: dir, name: basename(dir) || dir, pinned: false, lastOpenedAt: Date.now() })
      this.trim()
    }
    this.commit()
  }

  togglePin(path: string): void {
    this.ensure()
    const entry = this.state.recent.find(r => r.path === path)
    if (entry) entry.pinned = !entry.pinned
    this.commit()
  }

  removeRecent(path: string): void {
    this.ensure()
    this.state.recent = this.state.recent.filter(r => r.path !== path)
    this.commit()
  }

  /** `backgroundImage: null` clears the wallpaper; omitting the key leaves it alone. */
  patchSettings(patch: SettingsPatch): AppSettings {
    this.ensure()
    if (patch.linkSyntax && ['wiki', 'dollar', 'both'].includes(patch.linkSyntax))
      this.state.settings.linkSyntax = patch.linkSyntax
    if (patch.role && ['member', 'lead'].includes(patch.role)) this.state.settings.role = patch.role
    if (typeof patch.assistantModel === 'string')
      this.state.settings.assistantModel = patch.assistantModel.trim() || undefined
    if (typeof patch.userName === 'string' && patch.userName.trim())
      this.state.settings.userName = patch.userName.trim().slice(0, 40)
    if ('backgroundImage' in patch)
      this.state.settings.backgroundImage = patch.backgroundImage || undefined
    if (typeof patch.backgroundDim === 'number' && Number.isFinite(patch.backgroundDim))
      this.state.settings.backgroundDim = Math.min(90, Math.max(0, Math.round(patch.backgroundDim)))
    if ('openRouterApiKey' in patch) {
      const value = patch.openRouterApiKey?.trim() || undefined
      if (value) {
        const encrypted = encryptSecret(value)
        if (encrypted) {
          this.state.settings.openRouterApiKeyEnc = encrypted
          delete this.state.settings.openRouterApiKey
        } else {
          // No keychain on this platform — store plainly rather than lose the key.
          this.state.settings.openRouterApiKey = value
          delete this.state.settings.openRouterApiKeyEnc
        }
      } else {
        delete this.state.settings.openRouterApiKey
        delete this.state.settings.openRouterApiKeyEnc
      }
    }
    this.commit()
    const { openRouterApiKeyEnc: _enc, ...settings } = this.state.settings
    return settings
  }

  /** Pinned first, then most recently opened. */
  private sortedRecent(): RecentDir[] {
    return this.state.recent
      .slice()
      .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.lastOpenedAt - a.lastOpenedAt)
  }

  /** Drops the oldest unpinned entries once the list outgrows the rail. */
  private trim(): void {
    const sorted = this.sortedRecent()
    const keep = new Set(sorted.slice(0, MAX_RECENT).map(r => r.path))
    this.state.recent = this.state.recent.filter(r => r.pinned || keep.has(r.path))
  }

  private ensure(): void {
    if (this.loaded) return
    this.loaded = true
    // Older builds wrote `{ workspaceDir }` only — missing fields fall back to defaults.
    const raw = readStoreJson<Partial<AppStateShape>>(this.file, {})
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
      settings: { ...DEFAULT_SETTINGS, ...(raw.settings || {}) }
    }
    // A state file written before wallpapers existed (or hand-edited) can carry a
    // non-numeric dim, which would otherwise reach the renderer as a broken alpha.
    if (!Number.isFinite(this.state.settings.backgroundDim))
      this.state.settings.backgroundDim = DEFAULT_SETTINGS.backgroundDim
    // Decrypt a stored key (and migrate an older plaintext key to the encrypted
    // field when the platform can encrypt it) so only ciphertext touches disk.
    if (this.state.settings.openRouterApiKeyEnc) {
      this.state.settings.openRouterApiKey = decryptSecret(this.state.settings.openRouterApiKeyEnc) || undefined
    } else if (this.state.settings.openRouterApiKey) {
      const encrypted = encryptSecret(this.state.settings.openRouterApiKey)
      if (encrypted) {
        this.state.settings.openRouterApiKeyEnc = encrypted
        delete this.state.settings.openRouterApiKey
        this.commit()
      }
    }
  }

  private commit(): void {
    try {
      writeJsonAtomic(this.file, this.state)
    } catch {
      /* a read-only profile must not take the app down */
    }
    this.emit('change', this.get())
  }
}
