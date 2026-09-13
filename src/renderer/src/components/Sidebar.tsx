import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Code2, FolderOpen, FolderPlus, Palette, Pencil, Pin, Plus, Settings, Trash2, UserRound, X } from 'lucide-react'
import type { CodeWorkspaceGroup, RecentDir } from '../../../preload/index.d'
import type { WorkView } from './TitleBar'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { THEMES, useTheme, wallpaperBackgroundImage } from '../theme'
import { useSettings } from '../hooks/useSettings'
import { VerifiedBadge } from './VerifiedBadge'
import { AppUpdates } from './AppUpdates'
import { useConfirm } from './ConfirmDialog'
import { MAX_FAVORITE_TERMINAL_NAMES, normalizeTerminalName, normalizeTerminalNameList } from '../../../main/terminalNames'
import { getCodeSessionCount, onCodeSessionCount } from '../lib/codeSessions'

interface Props {
  workspaceDir: string | null
  activeView?: WorkView
  onPickDir(): void
}

function IconButton({
  label,
  active,
  danger,
  badge,
  testId,
  pressed,
  expanded,
  onClick,
  children
}: {
  label: string
  active?: boolean
  danger?: boolean
  badge?: number
  testId?: string
  pressed?: boolean
  expanded?: boolean
  onClick(): void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <button
      style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
      data-testid={testId}
      className={[
        'group relative grid h-[38px] w-[38px] place-items-center rounded-[10px] border border-transparent text-text-dim transition-colors duration-150',
        active
          ? 'rail-btn-active'
          : danger
            ? 'hover:bg-danger/15 hover:text-danger'
            : 'hover:bg-bg-hover hover:text-text'
      ].join(' ')}
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={pressed ?? active}
      aria-expanded={expanded}
    >
      {children}
      {badge ? (
        <span className="absolute top-0.5 right-0.5 min-w-[15px] rounded-full bg-accent px-1 text-[9px] leading-[15px] font-semibold text-bg">
          {badge}
        </span>
      ) : null}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] z-[900] max-w-[min(20rem,calc(100vw-72px))] overflow-hidden rounded-[10px] border border-line bg-bg-panel px-2.5 py-1.5 text-[11px] text-ellipsis whitespace-nowrap text-text opacity-0 transition-all duration-150 -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  )
}

const SETTINGS_TABS = [
  { id: 'account' as const, label: 'Account', Icon: UserRound },
  { id: 'appearance' as const, label: 'Appearance', Icon: Palette }
]

const FAVORITE_WIDGETS = [
  ['terminal', 'Terminal', 'Shell in the current workspace'],
  ['files', 'Files', 'Browse workspace files'],
  ['sys-monitor', 'System Monitor', 'CPU, RAM and processes'],
  ['timer', 'Timer', 'Countdown or stopwatch'],
  ['planner', 'Planner', 'Daily agenda and checklist'],
  ['orchestration', 'Orchestration', 'The agent fleet: tasks, workers and their questions'],
  ['browser', 'Browser', 'Embedded web page'],
  ['links', 'Links', 'Saved links'],
  ['music-player', 'Music Player', 'Stream YouTube, Yandex Music, Spotify or MP3 links']
] as const












const CAPTION = 'text-[11px] font-medium tracking-[0.08em] text-text-faint uppercase'
const BTN_QUIET =
  'min-h-9 rounded-[8px] border border-line-soft px-3 py-1.5 text-[11px] text-text-dim outline-none transition-colors duration-150 hover:border-line hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-35'
const BTN_PRIMARY =
  'min-h-9 rounded-[8px] bg-accent px-3.5 py-1.5 text-[11px] font-medium text-bg outline-none transition-opacity duration-150 hover:opacity-90 focus-visible:ring-1 focus-visible:ring-line focus-visible:ring-offset-2 focus-visible:ring-offset-bg-panel disabled:cursor-not-allowed disabled:opacity-35'

function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <h3 className={CAPTION}>{title}</h3>
        {hint && <p className="text-[11px] leading-relaxed text-text-faint">{hint}</p>}
      </div>
      {children}
    </section>
  )
}


function Choice({
  selected,
  label,
  hint,
  mono,
  disabled,
  onClick
}: {
  selected: boolean
  label: string
  hint?: string
  mono?: boolean
  disabled?: boolean
  onClick(): void
}): React.JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onClick}
      className={`flex min-h-9 flex-col gap-1.5 rounded-[10px] border p-3.5 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-line ${
        selected ? 'border-line bg-bg-hover' : 'border-line-soft bg-transparent hover:border-line hover:bg-bg-hover'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={`text-xs ${selected ? 'text-text' : 'text-text-dim'}`}>{label}</span>
        <span className="flex items-center gap-2">
          {selected && <span className="flex-none text-[10px] text-text-faint">Active</span>}
          <span aria-hidden="true" className={`grid h-4 w-4 place-items-center rounded-full border ${selected ? 'border-text' : 'border-line'}`}>
            {selected && <span className="h-1.5 w-1.5 rounded-full bg-text" />}
          </span>
        </span>
      </span>
      {hint && (
        <span className={`text-[10px] leading-relaxed text-text-faint ${mono ? 'font-mono' : ''}`}>{hint}</span>
      )}
    </button>
  )
}


function Slider({
  label,
  value,
  onChange
}: {
  label: string
  value: number
  onChange(value: number): void
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-3 text-[11px] text-text-dim">
      <span className="w-8 flex-none">{label}</span>
      <input
        className="min-w-0 flex-1 accent-white"
        type="range"
        min={0}
        max={90}
        step={5}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="w-9 flex-none text-right font-mono text-text-faint">{value}%</span>
    </label>
  )
}


export function SettingsModal({
  workspaceDir,
  listenForToolbar = false
}: {
  workspaceDir?: string | null
  listenForToolbar?: boolean
}): React.JSX.Element {
  const { theme, setTheme, background, dim, setDim, blur, setBlur, pickBackground, clearBackground, error } = useTheme()
  const { settings, update, error: settingsError } = useSettings()
  const [tab, setTab] = useState<'appearance' | 'account'>('account')
  const [userName, setUserName] = useState('')
  const [favoriteNamesText, setFavoriteNamesText] = useState('')
  const nameEntries = favoriteNamesText.split(/[\n,]+/).map((name) => name.trim()).filter(Boolean)
  const favoriteNames = normalizeTerminalNameList(nameEntries)
  const namesError = nameEntries.some((name) => !normalizeTerminalName(name))
    ? 'Use 1–32 characters per name: English letters, numbers, - or _. Start with a letter.'
    : new Set(nameEntries.map((name) => name.toLowerCase())).size > MAX_FAVORITE_TERMINAL_NAMES
      ? `Add up to ${MAX_FAVORITE_TERMINAL_NAMES} names.`
      : null
  const namesChanged = JSON.stringify(favoriteNames) !== JSON.stringify(settings.favoriteTerminalNames ?? [])
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  useFocusTrap(dialogRef, open)

  useEffect(() => {
    if (open) setFavoriteNamesText((settings.favoriteTerminalNames ?? []).join('\n'))
  }, [open, settings.favoriteTerminalNames])

  const saveFavoriteNames = async (): Promise<void> => {
    if (namesError || busy) return
    setBusy(true)
    try {
      const saved = await update({ favoriteTerminalNames: favoriteNames })
      setNotice(saved ? 'Favorite terminal names saved.' : 'Failed to save terminal names.')
    } catch {
      setNotice('Failed to save terminal names.')
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 })
  }, [tab])

  useEffect(() => {
    if (!open) return
    setUserName(settings.userName || 'you')
    void window.api.settings
      .get()
      .then((next) => {
        if (next.userName) setUserName(next.userName)
      })
      .catch((err) => console.warn('settings:get failed', err))
  }, [open, settings.userName])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        e.stopImmediatePropagation()
        setOpen(false)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [open])

  useEffect(() => {
    setNotice(null)
  }, [tab, open])

  useEffect(() => {
    const openAccount = (): void => {
      setTab('account')
      setOpen(true)
    }
    window.addEventListener('orcspace:open-account', openAccount)
    return () => {
      window.removeEventListener('orcspace:open-account', openAccount)
    }
  }, [])

  useEffect(() => {
    if (!listenForToolbar) return
    // Callers that know which panel they mean can name it; anything that
    // just wants "open settings" keeps landing on Account as before.
    const openSettings = (event: Event): void => {
      const requested = (event as CustomEvent<{ tab?: string } | undefined>).detail?.tab
      setTab(requested === 'appearance' ? 'appearance' : 'account')
      setOpen(true)
    }
    window.addEventListener('orcspace:open-settings', openSettings)
    return () => {
      window.removeEventListener('orcspace:open-settings', openSettings)
    }
  }, [listenForToolbar])

  const saveAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await update({
        userName: userName.trim() || 'you'
      })
      setNotice(saved ? 'Account settings saved.' : 'Failed to save account settings.')
    } catch (err) {
      setNotice(`Failed to save account: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const dialog =
    open &&



    createPortal(
      <div
        className="fixed inset-x-0 top-10 bottom-0 z-[50000] flex items-center justify-center bg-bg/80 px-7 py-6 backdrop-blur-[2px]"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        role="presentation"
        onClick={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          data-testid="settings-modal"
          className="pop-in flex max-h-[calc(100vh-40px)] w-[min(820px,calc(100vw-56px))] flex-col overflow-hidden rounded-[12px] border border-line bg-bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.36)] sm:flex-row"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <nav className="flex flex-none gap-1 overflow-x-auto border-b border-line bg-bg-raise p-2.5 sm:w-[160px] sm:flex-col sm:border-r sm:border-b-0 sm:p-3">
            <div className={`${CAPTION} hidden px-2.5 pt-1 pb-3.5 sm:block`}>Settings</div>
            {SETTINGS_TABS.map(({ id, label, Icon }) => (
              <button
                type="button"
                key={id}
                data-testid={`settings-tab-${id}`}
                aria-current={tab === id ? 'true' : undefined}
                className={`flex min-h-9 flex-none items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-left text-xs outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-line sm:w-full ${
                  tab === id ? 'border border-line bg-bg-hover text-text' : 'border border-transparent text-text-dim hover:bg-bg-hover hover:text-text'
                }`}
                onClick={() => setTab(id)}
              >
                <Icon size={14} strokeWidth={1.6} className="flex-none opacity-80" />
                {label}
              </button>
            ))}
          </nav>
          <main ref={mainRef} className="flex min-w-0 flex-1 flex-col gap-7 overflow-auto bg-bg-panel px-7 py-6 min-h-0">
            <header className="flex flex-none items-center justify-between">
              <h2 className="text-[20px] font-semibold text-text">
                {tab === 'appearance' ? 'Appearance' : 'Account'}
              </h2>
              <button
                type="button"
                className="grid h-9 w-9 place-items-center rounded-[8px] text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line"
                onClick={() => setOpen(false)}
                aria-label="Close settings"
              >
                <X size={15} />
              </button>
            </header>

            {tab === 'appearance' && (
              <div className="flex max-w-xl flex-col gap-8">
                <Section title="Theme">
                  <div role="radiogroup" aria-label="Theme" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    {THEMES.map((item) => (
                      <Choice
                        key={item.id}
                        selected={theme === item.id}
                        label={item.label}
                        hint={item.hint}
                        disabled={busy}
                        onClick={() => {
                          setTheme(item.id)
                          if (item.id === 'photo' && !background) void pickBackground()
                        }}
                      />
                    ))}
                  </div>
                </Section>

                <Section title="Terminal shell" hint="Shell used when opening new terminal widgets on Windows.">
                  <div role="radiogroup" aria-label="Terminal shell" className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                    <Choice
                      selected={settings.windowsShell === 'cmd'}
                      label="Command Prompt (CMD)"
                      hint="cmd.exe"
                      mono
                      disabled={busy}
                      onClick={() => void update({ windowsShell: 'cmd' })}
                    />
                    <Choice
                      selected={settings.windowsShell === 'powershell'}
                      label="PowerShell"
                      hint="powershell.exe"
                      mono
                      disabled={busy}
                      onClick={() => void update({ windowsShell: 'powershell' })}
                    />
                  </div>
                </Section>

                <Section title="Right-click menu" hint="Which widgets appear when you right-click the canvas.">
                  <div className="-mx-2 flex flex-col">
                    {FAVORITE_WIDGETS.map(([id, label, hint]) => {
                      const selected = (settings.favoriteWidgets ?? []).includes(id)
                      return (
                        <label
                          key={id}
                          className="flex min-h-9 cursor-pointer items-center gap-3 rounded-[8px] px-2 py-2 text-xs text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text focus-within:bg-bg-hover focus-within:ring-1 focus-within:ring-line"
                        >
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() =>
                              void update({
                                favoriteWidgets: selected
                                  ? (settings.favoriteWidgets ?? []).filter((kind) => kind !== id)
                                  : [...(settings.favoriteWidgets ?? []), id]
                              })
                            }
                            className="h-4 w-4 flex-none accent-white outline-none focus-visible:ring-1 focus-visible:ring-line"
                          />
                          {
}
                          <span className="w-28 flex-none">{label}</span>
                          <span className="min-w-0 flex-1 truncate text-[11px] text-text-faint">{hint}</span>
                        </label>
                      )
                    })}
                  </div>
                </Section>

                <Section title="Background">
                  {background ? (
                    <div
                      className="h-32 rounded-[10px] border border-line-soft bg-cover bg-center"
                      style={{ backgroundImage: wallpaperBackgroundImage(background) }}
                    />
                  ) : (
                    <div className="rounded-[10px] border border-dashed border-line-soft px-3 py-8 text-center text-[11px] text-text-faint">
                      No background selected
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button type="button" className={BTN_QUIET} onClick={() => void pickBackground()}>
                      Choose…
                    </button>
                    {background && (
                      <button type="button" className={BTN_QUIET} onClick={clearBackground}>
                        Remove
                      </button>
                    )}
                  </div>
                  <div className="flex flex-col gap-3 pt-1">
                    <Slider label="Blur" value={blur} onChange={setBlur} />
                    <Slider label="Dim" value={dim} onChange={setDim} />
                  </div>
                  {error && <p className="text-[11px] text-danger">{error}</p>}
                </Section>

              </div>
            )}

            {tab === 'account' && (
              <div className="flex max-w-xl flex-col gap-8">
                <p className="-mt-5 text-[11px] leading-relaxed text-text-dim">Manage the local profile used throughout this workspace.</p>
                <div className="flex items-center gap-3.5 rounded-[12px] border border-line-soft bg-bg-raise p-4">
                  <div className="grid h-11 w-11 flex-none place-items-center rounded-full border border-line-soft bg-bg-raise text-[13px] font-medium text-text select-none">
                    {(userName.trim() || settings.userName || 'you').slice(0, 2).toUpperCase()}
                  </div>
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-center gap-1.5">
                      <span className="truncate text-sm text-text">
                        {userName.trim() || settings.userName || 'you'}
                      </span>
                      <VerifiedBadge size={14} />
                    </div>
                    <p className="text-[11px] text-text-faint">
                      operator <span className="font-mono">user</span>
                    </p>
                  </div>
                </div>

                <Section
                  title="Display name"
                  hint="Shown across your workspace."
                >
                  <input
                    className="w-full rounded-[8px] border border-line-soft bg-transparent px-3 py-2.5 text-xs text-text outline-none transition-colors duration-150 focus:border-line"
                    type="text"
                    aria-label="Display name"
                    maxLength={40}
                    value={userName}
                    onChange={(event) => setUserName(event.target.value)}
                    placeholder="e.g. you"
                  />
                  <div>
                    <button
                      type="button"
                      className={BTN_PRIMARY}
                      disabled={busy || !userName.trim() || userName.trim() === settings.userName}
                      onClick={() => void saveAccount()}
                    >
                      Save
                    </button>
                  </div>
                </Section>

                <Section title="Favorite terminal names"
                  hint="One name per line, or separated by commas. New terminals use the first available name from your list, then an English male name. Remove all names to use defaults.">
                  <textarea
                    aria-label="Favorite terminal names"
                    aria-invalid={Boolean(namesError)}
                    aria-describedby={namesError ? 'favorite-terminal-names-error' : undefined}
                    rows={5}
                    maxLength={4096}
                    value={favoriteNamesText}
                    onChange={(event) => setFavoriteNamesText(event.target.value)}
                    placeholder={'James\nHenry\nOliver'}
                    className="w-full resize-y rounded-[8px] border border-line-soft bg-transparent px-3 py-2.5 text-xs text-text outline-none focus:border-line"
                  />
                  {namesError && <p id="favorite-terminal-names-error" role="alert" className="text-[11px] text-danger">{namesError}</p>}
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[11px] text-text-faint">{favoriteNames.length} / {MAX_FAVORITE_TERMINAL_NAMES} names</span>
                    <button type="button" className={BTN_PRIMARY} disabled={busy || Boolean(namesError) || !namesChanged}
                      onClick={() => void saveFavoriteNames()}>Save names</button>
                  </div>
                </Section>

                <Section title="Session">
                  <dl className="flex flex-col gap-2 text-[11px] text-text-faint">
                    <div className="flex gap-3">
                      <dt className="w-28 flex-none">Active folder</dt>
                      <dd className="min-w-0 flex-1 truncate font-mono text-text-dim">{workspaceDir || 'None'}</dd>
                    </div>
                    <div className="flex gap-3">
                      <dt className="w-28 flex-none">Credentials</dt>
                      <dd className="min-w-0 flex-1 text-text-dim">Encrypted locally via OS safeStorage</dd>
                    </div>
                  </dl>
                </Section>
              </div>
            )}

            <AppUpdates />
            {(notice || settingsError) && (
              <div className="flex flex-col gap-1.5">
                {notice && <p role="status" aria-live="polite" className="text-[11px] text-text-faint">{notice}</p>}
                {settingsError && (
                  <p role="alert" className="text-[11px] text-danger">
                    Failed to save settings: {settingsError}
                  </p>
                )}
              </div>
            )}
          </main>
        </div>
      </div>,
      document.body
    )

  return (
    <>
      {/* The toolbar already renders its own visible trigger and dispatches
          orcspace:open-settings (handled above) when listenForToolbar is set
          — this instance only needs to own the dialog. Rendering the default
          IconButton too used to add a second, invisible trigger sitting at
          the top of the page under the fixed title bar: unreachable by
          click, but still present in the DOM and tab order. */}
      {!listenForToolbar && (
        <IconButton label="Settings" testId="rail-settings" onClick={() => setOpen(true)}>
          <Settings size={17} />
        </IconButton>
      )}
      {dialog}
    </>
  )
}







export default React.memo(function Sidebar({
  workspaceDir,
  activeView = 'canvas',
  onPickDir
}: Props): React.JSX.Element {
  const { settings } = useSettings()
  const confirm = useConfirm()
  const [recent, setRecent] = useState<RecentDir[]>([])
  const [codeWorkspaceGroups, setCodeWorkspaceGroups] = useState<CodeWorkspaceGroup[]>([])
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [foldersError, setFoldersError] = useState<string | null>(null)
  const [creatingWorkspace, setCreatingWorkspace] = useState(false)
  const foldersRef = useRef<HTMLDivElement>(null)
  const foldersMenuRef = useRef<HTMLDivElement>(null)
  const dirName = workspaceDir ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() : null
  const avatarName = settings.userName?.trim() || 'you'
  const avatarInitials = avatarName.slice(0, 2).toUpperCase()
  const expanded = activeView !== 'canvas'

  /**
   * Whether Code has anything running.
   *
   * The workspace panel is hidden until the first session: before that there
   * is nothing to save a workspace *of*, and it repeats the folder line the
   * launcher already shows, so the same choice appears twice in two places.
   * CodeView owns the count and the sidebar subscribes, rather than App
   * passing it down: App's `codeStarted` means "Code was opened", which is a
   * different thing. A subscription rather than an event, because the two
   * components do not mount in a fixed order — see lib/codeSessions.
   */
  const [hasCodeSessions, setHasCodeSessions] = useState(getCodeSessionCount() > 0)
  useEffect(() => onCodeSessionCount((count) => setHasCodeSessions(count > 0)), [])


  const refreshCodeWorkspaceGroups = useCallback((): void => {
    void window.api.workspace.codeWorkspaceGroups().then(setCodeWorkspaceGroups).catch(() => {})
  }, [])

  useEffect(() => {
    void window.api.workspace
      .recent()
      .then(setRecent)
      .catch((err) => console.warn('workspace:recent failed', err))
    return window.api.workspace.onRecentChange((next) => {
      setRecent(next)
      refreshCodeWorkspaceGroups()
    })
  }, [refreshCodeWorkspaceGroups])

  useEffect(() => {
    void window.api.workspace.codeWorkspaces().catch(() => {})
    refreshCodeWorkspaceGroups()
    return window.api.workspace.onCodeWorkspaceChange(() => {
      refreshCodeWorkspaceGroups()
    })
  }, [refreshCodeWorkspaceGroups])

  useEffect(() => {
    if (!foldersOpen) return
    const onDown = (e: MouseEvent): void => {
      if (foldersRef.current && !foldersRef.current.contains(e.target as Node)) setFoldersOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        setFoldersOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [foldersOpen])


  useEffect(() => {
    if (!foldersOpen) return
    const el = foldersMenuRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const maxTop = window.innerHeight - rect.height - 4
    const clampedTop = Math.min(rect.top, Math.max(4, maxTop))
    if (clampedTop !== rect.top) {
      el.style.top = `${clampedTop - rect.top + el.offsetTop}px`
    }
  }, [foldersOpen, recent.length])

  const open = async (path: string): Promise<void> => {



    try {
      window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
      const result = await window.api.workspace.openRecent(path)
      if (result && typeof result === 'object' && 'error' in result) {
        setFoldersError(result.error)
        return
      }
      setFoldersError(null)
      setFoldersOpen(false)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    }
  }

  const pinRecent = async (path: string): Promise<void> => {
    try {
      await window.api.workspace.pinRecent(path)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    }
  }

  const forgetRecent = async (path: string): Promise<void> => {
    try {
      await window.api.workspace.forgetRecent(path)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    }
  }

  const openCreateWorkspace = (folder = workspaceDir): void => {
    setFoldersOpen(false)
    setFoldersError(null)
    void createWorkspace(folder)
  }

  const createWorkspace = async (folder: string | null): Promise<void> => {
    if (creatingWorkspace) return
    setCreatingWorkspace(true)
    try {
      window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
      if (folder && folder !== workspaceDir) {
        const opened = await window.api.workspace.openRecent(folder)
        if (opened && typeof opened === 'object' && 'error' in opened) {
          setFoldersError(opened.error)
          return
        }
      }
      const result = await window.api.workspace.createCodeWorkspace()
      if (result && typeof result === 'object' && 'error' in result) {
        setFoldersError(result.error)
        return
      }
      if (result && typeof result === 'object' && 'id' in result) {
        setFoldersError(null)
      }
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreatingWorkspace(false)
    }
  }

  const [renameTarget, setRenameTarget] = useState<null | { kind: 'folder' | 'code'; id: string; current: string; folder?: string }>(null)
  const [renameValue, setRenameValue] = useState('')
  const renameRef = useRef<HTMLFormElement>(null)
  useFocusTrap(renameRef, !!renameTarget)

  const openRename = (kind: 'folder' | 'code', id: string, currentName: string, folder?: string): void => {
    setRenameTarget({ kind, id, current: currentName, folder })
    setRenameValue(currentName)
  }

  const submitRename = async (): Promise<void> => {
    if (!renameTarget) return
    const nextName = renameValue.trim()
    if (!nextName || nextName === renameTarget.current) {
      setRenameTarget(null)
      return
    }
    try {
      if (renameTarget.kind === 'folder') {
        const result = await window.api.workspace.rename(renameTarget.id, nextName)
        if (result && !Array.isArray(result) && 'error' in result) {
          setFoldersError(result.error)

          return
        }
        setFoldersError(null)
      } else {
        // Switch folders only on save, not when the dialog opens: opening
        // rename on another folder must not move the user there if they cancel.
        const targetFolder = renameTarget.folder
        if (targetFolder && targetFolder !== workspaceDir) {
          window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
          const opened = await window.api.workspace.openRecent(targetFolder)
          if (opened && typeof opened === 'object' && 'error' in opened) {
            setFoldersError(opened.error)
            return
          }
        }
        const result = await window.api.workspace.renameCodeWorkspace(renameTarget.id, nextName)
        if ('error' in result) {
          setFoldersError(result.error)

          return
        }
        setFoldersError(null)
      }
      setRenameTarget(null)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))

    }
  }

  const renameCodeWorkspace = (folder: string, id: string, currentName: string): void => {
    openRename('code', id, currentName, folder)
  }

  const deleteCodeWorkspace = async (folder: string, id: string, name: string): Promise<void> => {
    const ok = await confirm(`Delete workspace “${name}”? Its saved sessions will no longer be available.`, {
      title: 'Delete workspace',
      danger: true,
      confirmLabel: 'Delete'
    })
    if (!ok) return
    // Flushing saves the mounted sessions before the scope moves. Deleting a
    // workspace that is neither in this folder nor active changes neither, so
    // there is nothing to flush — skip the save and the reload it would cause.
    const activeId = codeWorkspaceGroups.find((group) => group.folder === folder)?.activeId
    const scopeMoves = folder !== workspaceDir || id === activeId
    if (scopeMoves) window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
    try {
      if (folder !== workspaceDir) {
        const opened = await window.api.workspace.openRecent(folder)
        if (opened && typeof opened === 'object' && 'error' in opened) {
          setFoldersError(opened.error)
          return
        }
      }
      const result = await window.api.workspace.deleteCodeWorkspace(id)
      if ('error' in result) setFoldersError(result.error)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    }
  }

  const selectCodeWorkspace = async (folder: string, id: string): Promise<void> => {
    const activeId = codeWorkspaceGroups.find((group) => group.folder === folder)?.activeId
    if (folder === workspaceDir && id === activeId) return
    window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
    try {
      if (folder !== workspaceDir) {
        const opened = await window.api.workspace.openRecent(folder)
        if (opened && typeof opened === 'object' && 'error' in opened) {
          setFoldersError(opened.error)
          return
        }
      }
      const result = await window.api.workspace.selectCodeWorkspace(id)
      if ('error' in result) setFoldersError(result.error)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))
    }
  }

  const RAIL_ITEM_IDS = ['folders'] as const
  type RailItemId = (typeof RAIL_ITEM_IDS)[number]
  const [order, setOrder] = useState<RailItemId[]>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('rail-order') || 'null') as string[] | null
      if (saved && Array.isArray(saved)) {
        const filtered = saved.filter((id): id is RailItemId => (RAIL_ITEM_IDS as readonly string[]).includes(id))
        const missing = RAIL_ITEM_IDS.filter((id) => !filtered.includes(id))
        return [...filtered, ...missing]
      }
    } catch {

    }
    return [...RAIL_ITEM_IDS]
  })
  const dragIdRef = useRef<RailItemId | null>(null)

  const reorder = (target: RailItemId): void => {
    const dragged = dragIdRef.current
    if (!dragged || dragged === target) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== dragged)
      const targetIndex = next.indexOf(target)
      if (targetIndex === -1) return prev
      next.splice(targetIndex, 0, dragged)
      return next
    })
  }

  React.useEffect(() => {
    try { localStorage.setItem('rail-order', JSON.stringify(order)) } catch {}
  }, [order])

  const railItems: Record<RailItemId, React.ReactNode> = {
    folders: (
      <div className="relative" ref={foldersRef}>
        <IconButton
          label={workspaceDir ? `Folders · current: ${dirName}` : 'Workspace Folders'}
          testId="rail-folders"
          active={foldersOpen}
          pressed={foldersOpen}
          expanded={foldersOpen}
          onClick={() => setFoldersOpen((v) => !v)}
        >
          <FolderOpen size={17} />
        </IconButton>

        {foldersOpen && (
          <div
            ref={foldersMenuRef}
            role="menu"
            aria-label="Workspace Folders"
            className="absolute top-0 left-[calc(100%+10px)] z-[9500] w-72 max-w-[calc(100vw-70px)] max-h-[calc(100vh-120px)] overflow-auto rounded-[10px] border border-line bg-bg-panel p-2 shadow-2xl"
            onKeyDown={(e) => {

              if (e.key === 'Escape') {
                e.stopPropagation()
                setFoldersOpen(false)
              }

              const items = Array.from(
                (e.currentTarget as HTMLElement).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')
              )
              if (items.length === 0) return
              const idx = items.indexOf(document.activeElement as HTMLButtonElement)
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                items[(idx + 1) % items.length]?.focus()
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                items[(idx - 1 + items.length) % items.length]?.focus()
              } else if (e.key === 'Enter') {

              }
            }}
          >
            <div className="px-1.5 pt-1 pb-2 text-[10px] tracking-wider text-text-faint uppercase">Workspace Folders</div>
            <div className="flex max-h-72 flex-col gap-1 overflow-auto">
{recent.map((entry) => (
                  <div
                    key={entry.path}
                    className={`group flex items-center gap-1 rounded-[10px] ${entry.path === workspaceDir ? 'bg-bg-hover' : ''}`}
                    title={entry.path}
                  >
                    <button
                      className="min-w-0 flex-1 px-2 py-1.5 text-left"
                      onClick={() => void open(entry.path)}
                      role="menuitem"
                    >
                      <b className="block truncate text-xs font-semibold text-text">{entry.name}</b>
                      <span className="block truncate text-[10px] text-text-faint">{entry.path}</span>
                    </button>
                    <button
                      className={`flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text ${entry.pinned ? 'text-accent' : ''}`}
                      title={entry.pinned ? 'Unpin' : 'Pin'}
                      aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
                      onClick={() => void pinRecent(entry.path)}
                    >
                      <Pin size={12} />
                    </button>
                    <button
                      className="flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text"
                      title="Remove from recent"
                      aria-label={`Remove ${entry.name} from recent`}
                      onClick={() => void forgetRecent(entry.path)}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
              {!recent.length && (
                <div className="px-2 py-3 text-center text-[11px] text-text-faint">Recent folders list is empty — select your first folder</div>
              )}
            </div>
            {foldersError && (
              <div className="px-2 pt-1 pb-2 text-[11px] leading-snug text-danger">{foldersError}</div>
            )}
            <button
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-3 py-2 text-xs font-semibold text-bg hover:opacity-90"
              onClick={() => {
                window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
                onPickDir()
                setFoldersOpen(false)
              }}
            >
              <FolderOpen size={14} /> Open Folder…
            </button>
          </div>
        )}
      </div>
    )
  }

  const renderExpanded = (): React.JSX.Element => {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex h-11 flex-none items-center border-b border-line px-3">
          <span className="text-[11px] font-semibold tracking-[0.08em] text-text-faint uppercase">Code</span>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
          <div className="space-y-3">
            {codeWorkspaceGroups.map((group) => {
              const currentFolder = group.folder === workspaceDir
              return (
                <div key={group.folder} className="min-w-0">
                  <div className="group/folder flex h-9 items-center gap-1 rounded-[8px] px-2" title={group.folder}>
                    <FolderOpen size={13} className={`flex-none ${currentFolder ? 'text-text' : 'text-text-faint'}`} />
                    <span className={`min-w-0 flex-1 truncate text-[11px] font-semibold ${currentFolder ? 'text-text' : 'text-text-dim'}`}>
                      {group.name}
                    </span>
                    <button
                      type="button"
                      aria-label={`Add workspace to ${group.name}`}
                      title="Add workspace"
                      data-testid={currentFolder ? 'workspace-create' : undefined}
                      disabled={creatingWorkspace}
                      onClick={() => openCreateWorkspace(group.folder)}
                      className="grid h-7 w-7 flex-none place-items-center rounded-[7px] text-text-faint transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:opacity-40"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="ml-[13px] border-l border-line-soft pl-2">
                    {group.workspaces.map((workspace) => {
                      const current = currentFolder && workspace.id === group.activeId
                      return (
                        <div key={workspace.id} className={`group flex min-w-0 items-center rounded-[8px] transition-colors ${current ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}>
                          <button
                            type="button"
                            data-testid={current ? 'current-workspace' : undefined}
                            aria-current={current ? 'page' : undefined}
                            className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-[8px] px-2 text-left text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-line ${current ? 'text-text' : 'text-text-dim'}`}
                            onClick={() => void selectCodeWorkspace(group.folder, workspace.id)}
                          >
                            <Code2 size={12} className="flex-none" />
                            <span className="min-w-0 truncate">{workspace.name}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Rename ${workspace.name}`}
                            title="Rename workspace"
                            className="grid h-8 w-7 flex-none place-items-center rounded-[7px] text-text-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-bg-raise hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                            onClick={() => void renameCodeWorkspace(group.folder, workspace.id, workspace.name)}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${workspace.name}`}
                            title="Delete workspace"
                            className="mr-0.5 grid h-8 w-7 flex-none place-items-center rounded-[7px] text-text-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-bg-raise hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                            onClick={() => void deleteCodeWorkspace(group.folder, workspace.id, workspace.name)}
                          >
                            <Trash2 size={11} strokeWidth={1.8} />
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })}
            {!codeWorkspaceGroups.length && (
              <div className="rounded-[8px] border border-line bg-bg-panel px-3 py-4 text-center text-[11px] text-text-faint">
                Open a folder to create your first workspace
              </div>
            )}
          </div>
          {foldersError && <div className="px-2 pt-3 text-[10px] leading-snug text-danger">{foldersError}</div>}
        </div>
        <button
          type="button"
          onClick={() => {
            window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
            onPickDir()
          }}
          className="mx-2 mb-2 flex h-9 flex-none items-center justify-center gap-2 rounded-[8px] border border-line bg-bg-hover px-3 text-[11px] font-medium text-text-dim transition-colors hover:bg-bg-raise hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        >
          <FolderPlus size={14} /> New folder
        </button>
      </div>
    )
  }

  const renameDialog = renameTarget ? createPortal(
    <div
      className="fixed inset-0 z-[60000] flex items-center justify-center bg-[#121212]/80 p-6 backdrop-blur-[2px]"
      role="presentation"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) setRenameTarget(null)
      }}
    >
      <form
        ref={renameRef}
        role="dialog"
        aria-modal="true"
        aria-label="Rename workspace"
        data-testid="rename-workspace-dialog"
        tabIndex={-1}
        className="pop-in flex w-[min(380px,calc(100vw-32px))] flex-col gap-4 rounded-[14px] border border-line-soft bg-bg-panel p-5 shadow-2xl"
        onSubmit={(event) => {
          event.preventDefault()
          void submitRename()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation()
            e.preventDefault()
            setRenameTarget(null)
          }
        }}
      >
        <div>
          <h2 className="text-[15px] font-medium text-text">Rename Workspace</h2>
          <p className="mt-1 truncate text-[11px] leading-relaxed text-text-faint" title={renameTarget.current}>
            Current name: {renameTarget.current}
          </p>
        </div>
        <label className="flex flex-col gap-1.5 text-[10px] font-medium tracking-[0.09em] text-text-faint uppercase">
          Workspace name
          <input
            autoFocus
            data-testid="rename-workspace-name"
            value={renameValue}
            onChange={(event) => setRenameValue(event.target.value)}
            maxLength={80}
            placeholder="Workspace name"
            aria-label="Workspace name"
            className="rounded-[8px] border border-line-soft bg-bg-raise px-3 py-2.5 text-xs font-normal tracking-normal text-text outline-none focus:border-line"
          />
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className={BTN_QUIET} onClick={() => setRenameTarget(null)}>Cancel</button>
          <button type="submit" className={BTN_PRIMARY} disabled={!renameValue.trim() || renameValue.trim() === renameTarget.current}>
            Save
          </button>
        </div>
      </form>
    </div>,
    document.body
  ) : null

  return (
    <>
    {renameDialog}
    <aside
      className={`rail-shell rail relative z-[45000] flex flex-none flex-col gap-1 border-r border-line pt-10 pb-2 select-none bg-[#121212] ${expanded ? 'is-expanded w-[200px] items-stretch' : 'w-rail items-center'}`}
      style={{ WebkitAppRegion: 'drag', backgroundColor: '#121212' } as React.CSSProperties}
    >
      {!expanded && <button
        type="button"
        aria-label="Account"
        title={`${avatarName} · Account`}
        className="group absolute bottom-[52px] left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-full border border-line bg-bg-raise p-[2px] transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-account'))}
      >
        <span className="grid h-full w-full place-items-center rounded-full bg-bg-panel text-[10px] font-bold text-text">
          {avatarInitials}
        </span>
      </button>}
      {expanded ? (hasCodeSessions ? renderExpanded() : <div className="min-h-0 flex-1" />) : (
        <>
          <div className="flex-1" />
          <div className="flex flex-col gap-1.5">
            {order.map((id) => (
              <div
                key={id}
                draggable
                style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
                onDragStart={() => {
                  dragIdRef.current = id
                }}
                onDragOver={(e) => {
                  e.preventDefault()
                  reorder(id)
                }}
                onDragEnd={() => {
                  dragIdRef.current = null
                }}
                className="cursor-grab active:cursor-grabbing"
              >
                {railItems[id]}
              </div>
            ))}
          </div>
          <div className="flex-1" />
        </>
      )}
      {expanded ? (
        <div className="flex flex-col gap-1 border-t border-line px-2 pt-2">
          <button
            type="button"
            className="flex h-10 items-center gap-2.5 rounded-[8px] px-2 text-left text-text-dim transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
            onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-account'))}
            aria-label="Account"
          >
            <span className="grid h-7 w-7 flex-none place-items-center rounded-full border border-line bg-bg-panel text-[9px] font-bold text-text">{avatarInitials}</span>
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-1 min-w-0">
                <span className="truncate text-[11px] font-medium text-text">{avatarName}</span>
                <VerifiedBadge size={12} />
              </span>
              <span className="block text-[9px] text-text-faint">Account</span>
            </span>
          </button>
          <button
            type="button"
            data-testid="rail-settings"
            className="flex h-9 items-center gap-2.5 rounded-[8px] px-2 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
            onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-settings'))}
          >
            <Settings size={15} />
            <span>Settings</span>
          </button>
        </div>
      ) : (
        <IconButton label="Settings" testId="rail-settings" onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-settings'))}>
          <Settings size={17} />
        </IconButton>
      )}
    </aside>
    </>
  )
})
