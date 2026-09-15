import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Bot, Code2, FolderOpen, FolderPlus, Palette, Pencil, Pin, Plus, Settings, Trash2, UserRound, X } from 'lucide-react'
import type { CodeWorkspaceGroup, RecentDir } from '../../../preload/index.d'
import type { ChatAuthEvent, ChatProvider, ChatProviderStatus } from '../../../preload/api'
import type { WorkView } from './TitleBar'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { THEMES, useTheme, wallpaperBackgroundImage } from '../theme'
import { useSettings } from '../hooks/useSettings'
import { VerifiedBadge } from './VerifiedBadge'
import { AppUpdates } from './AppUpdates'
import { useConfirm } from './ConfirmDialog'
import { MAX_FAVORITE_TERMINAL_NAMES, normalizeTerminalName, normalizeTerminalNameList } from '../../../main/terminalNames'
import ClaudeIcon from './ClaudeIcon'
import CodexIcon from './CodexIcon'
import GrokIcon from './GrokIcon'
import { monochrome } from '../ui/tokens'

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
        'group relative grid h-[38px] w-[38px] place-items-center rounded-pill border border-transparent text-text-dim transition-colors duration-150',
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
        <span className="absolute top-0.5 right-0.5 min-w-[15px] rounded-pill bg-accent px-1 text-[9px] leading-[15px] font-semibold text-bg">
          {badge}
        </span>
      ) : null}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] z-[900] max-w-[min(20rem,calc(100vw-72px))] overflow-hidden rounded-panel border border-line bg-bg-panel px-2.5 py-1.5 text-[11px] text-ellipsis whitespace-nowrap text-text opacity-0 transition-all duration-150 -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  )
}

const SETTINGS_TABS = [
  { id: 'account' as const, label: 'Account', Icon: UserRound },
  { id: 'appearance' as const, label: 'Appearance', Icon: Palette },
  { id: 'ai' as const, label: 'AI', Icon: Bot }
]

type SettingsTab = (typeof SETTINGS_TABS)[number]['id']

// Keyed off SETTINGS_TABS rather than a hand-written union, so adding a tab
// without giving it a subtitle is a compile error instead of a blank line.
const SETTINGS_TAB_HINTS: Record<SettingsTab, string> = {
  account: 'Manage the local profile used throughout this workspace.',
  appearance: 'Theme, shell and what the canvas right-click menu offers.',
  ai: 'Connect an AI account once, then use its subscription in every AI Chat widget.'
}

const FAVORITE_WIDGETS = [
  ['terminal', 'Terminal', 'Shell in the current workspace'],
  ['files', 'Files', 'Browse workspace files'],
  ['sys-monitor', 'System Monitor', 'CPU, RAM and processes'],
  ['timer', 'Timer', 'Countdown or stopwatch'],
  ['planner', 'Planner', 'Daily agenda and checklist'],
  ['orchestration', 'Orchestration', 'The agent fleet: tasks, workers and their questions'],
  ['browser', 'Browser', 'Embedded web page'],
  ['links', 'Links', 'Saved links'],
  ['music-player', 'Music Player', 'Stream YouTube, Yandex Music, Spotify or MP3 links'],
  ['chat', 'AI Chat', 'Chat with an authenticated model']
] as const

const AI_PROVIDERS: Array<{ id: ChatProvider; label: string; hint: string; Icon: React.ComponentType<{ size?: number }> }> = [
  { id: 'chatgpt', label: 'ChatGPT', hint: 'Codex account and subscription', Icon: CodexIcon },
  { id: 'claude', label: 'Claude', hint: 'Claude Code account and subscription', Icon: ClaudeIcon },
  { id: 'grok', label: 'Grok', hint: 'Grok CLI account and subscription', Icon: GrokIcon }
]

const AI_MODELS: Record<ChatProvider, string[]> = {
  chatgpt: ['gpt-5.6-sol', 'gpt-6-astra', 'gpt-5.6-luna'],
  claude: ['claude-fable-5-1', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5-20251001'],
  grok: ['grok-4.6', 'grok-4.5', 'grok-4.3', 'grok-build-0.1']
}












const CAPTION = 'text-[11px] font-medium tracking-[0.08em] text-text-faint uppercase'
const BTN_QUIET =
  'min-h-9 rounded-panel border border-line-soft px-3 py-1.5 text-[11px] text-text-dim outline-none transition-colors duration-150 hover:border-line hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line disabled:cursor-not-allowed disabled:opacity-35'
const BTN_PRIMARY =
  'min-h-9 rounded-panel bg-accent px-3.5 py-1.5 text-[11px] font-medium text-bg outline-none transition-opacity duration-150 hover:opacity-90 focus-visible:ring-1 focus-visible:ring-line focus-visible:ring-offset-2 focus-visible:ring-offset-bg-panel disabled:cursor-not-allowed disabled:opacity-35'

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
      className={`flex min-h-9 flex-col gap-1.5 rounded-panel border p-3.5 text-left outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-line ${
        selected ? 'border-line bg-bg-hover' : 'border-line-soft bg-transparent hover:border-line hover:bg-bg-hover'
      } ${disabled ? 'pointer-events-none opacity-50' : ''}`}
    >
      <span className="flex items-center justify-between gap-2">
        <span className={`text-xs ${selected ? 'text-text' : 'text-text-dim'}`}>{label}</span>
        <span className="flex items-center gap-2">
          {selected && <span className="flex-none text-[10px] text-text-faint">Active</span>}
          <span aria-hidden="true" className={`grid h-4 w-4 place-items-center rounded-pill border ${selected ? 'border-text' : 'border-line'}`}>
            {selected && <span className="h-1.5 w-1.5 rounded-pill bg-text" />}
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
  const [tab, setTab] = useState<SettingsTab>('account')
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
  const [providerStatuses, setProviderStatuses] = useState<ChatProviderStatus[]>([])
  const [authPrompt, setAuthPrompt] = useState<ChatAuthEvent | null>(null)
  const [authCode, setAuthCode] = useState('')
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
    if (!open || tab !== 'ai') return
    void window.api.chat.providers().then(setProviderStatuses).catch(() => setProviderStatuses([]))
  }, [open, tab])

  useEffect(() => window.api.chat.onAuthEvent((auth) => {
    setAuthPrompt(auth.type === 'complete' ? null : auth)
    setNotice(auth.message)
    if (auth.type === 'complete' || auth.type === 'error') {
      void window.api.chat.providers().then(setProviderStatuses).catch(() => {})
    } else {
      setProviderStatuses((current) => current.map((provider) => provider.id === auth.provider
        ? { ...provider, connecting: true, detail: 'Waiting for OAuth sign-in' }
        : provider))
    }
  }), [])

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
      setTab(requested === 'appearance' ? 'appearance' : requested === 'ai' ? 'ai' : 'account')
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

  const connectProvider = async (provider: ChatProvider): Promise<void> => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    setAuthPrompt(null)
    setAuthCode('')
    try {
      const result = await window.api.chat.connect(provider)
      setNotice(result.ok ? 'Starting OAuth sign-in…' : (result.error || 'Could not start sign-in.'))
      void window.api.chat.providers().then(setProviderStatuses).catch(() => {})
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not start sign-in.')
    } finally {
      setBusy(false)
    }
  }

  const submitAuthCode = async (): Promise<void> => {
    if (!authPrompt?.requiresInput || !authCode.trim() || busy) return
    setBusy(true)
    try {
      const result = await window.api.chat.submitAuthCode(authPrompt.provider, authCode)
      setNotice(result.ok ? 'Finishing OAuth sign-in…' : (result.error || 'Could not submit the OAuth code.'))
      if (result.ok) setAuthCode('')
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not submit the OAuth code.')
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
          className="pop-in flex max-h-[calc(100vh-40px)] w-[min(820px,calc(100vw-56px))] flex-col overflow-hidden rounded-panel border border-line bg-bg-panel shadow-[0_24px_80px_rgba(0,0,0,0.36)] sm:flex-row"
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
                className={`flex min-h-9 flex-none items-center gap-2.5 rounded-panel px-2.5 py-1.5 text-left text-xs outline-none transition-colors duration-150 focus-visible:ring-1 focus-visible:ring-line sm:w-full ${
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
            {/* The subtitle belongs to the header block. It used to be the
                first child of this `gap-7` column with a -mt-5 pulling it back
                up under the title, so the spacing only looked right on the two
                tabs that happened to have one. */}
            <header className="flex flex-none items-start justify-between gap-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <h2 className="text-[20px] font-semibold text-text">
                  {SETTINGS_TABS.find((item) => item.id === tab)?.label ?? 'Account'}
                </h2>
                <p className="text-[11px] leading-relaxed text-text-dim">{SETTINGS_TAB_HINTS[tab]}</p>
              </div>
              <button
                type="button"
                className="grid h-9 w-9 place-items-center rounded-pill text-text-faint outline-none transition-colors duration-150 hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line"
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
                          className="flex min-h-9 cursor-pointer items-center gap-3 rounded-panel px-2 py-2 text-xs text-text-dim transition-colors duration-150 hover:bg-bg-hover hover:text-text focus-within:bg-bg-hover focus-within:ring-1 focus-within:ring-line"
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
                      className="h-32 rounded-panel border border-line-soft bg-cover bg-center"
                      style={{ backgroundImage: wallpaperBackgroundImage(background) }}
                    />
                  ) : (
                    <div className="rounded-panel border border-dashed border-line-soft px-3 py-8 text-center text-[11px] text-text-faint">
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
                <div className="flex flex-col gap-3 rounded-panel border border-line-soft bg-bg-raise p-4 sm:flex-row sm:items-center sm:justify-between">
                  <div className="flex min-w-0 items-center gap-3.5">
                    <div className="grid h-11 w-11 flex-none place-items-center rounded-pill border border-line-soft bg-bg-panel text-[13px] font-medium text-text select-none">
                      {(userName.trim() || settings.userName || 'you').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium text-text">
                          {userName.trim() || settings.userName || 'you'}
                        </span>
                        <span className="inline-flex items-center gap-1 rounded-pill bg-bg-hover px-2 py-0.5 text-[10px] text-text-dim border border-line-soft">
                          <span className="h-1.5 w-1.5 rounded-pill bg-ok" />
                          Connected
                        </span>
                      </div>
                      <p className="truncate text-[11px] text-text-faint">
                        {userName.trim() ? `${userName.trim().toLowerCase().replace(/\s+/g, '.')}@orcspace.local` : 'operator@orcspace.local'}
                      </p>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
                    <button
                      type="button"
                      className="min-h-[30px] rounded-panel border border-line-soft px-2.5 py-1 text-[11px] text-text-dim outline-none transition-colors duration-150 hover:border-line hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line"
                      onClick={() => setNotice('Account is managed on this device.')}
                    >
                      Manage account
                    </button>
                    <button
                      type="button"
                      className="min-h-[30px] rounded-panel border border-line-soft px-2.5 py-1 text-[11px] text-text-dim outline-none transition-colors duration-150 hover:border-line hover:bg-bg-hover hover:text-text focus-visible:ring-1 focus-visible:ring-line"
                      onClick={() => {
                        setUserName('')
                        setNotice('Ready to switch account. Enter a new name below.')
                      }}
                    >
                      Switch account
                    </button>
                    <button
                      type="button"
                      className="min-h-[30px] rounded-panel border border-line-soft px-2.5 py-1 text-[11px] text-text-faint outline-none transition-colors duration-150 hover:border-line hover:bg-bg-hover hover:text-danger focus-visible:ring-1 focus-visible:ring-line"
                      onClick={() => {
                        void update({ userName: '' })
                        setUserName('')
                        setNotice('Signed out of local operator profile.')
                      }}
                    >
                      Sign out
                    </button>
                  </div>
                </div>

                <Section
                  title="Display name"
                  hint="Shown across your workspace."
                >
                  <input
                    className="w-full rounded-panel border border-line-soft bg-transparent px-3 py-2.5 text-xs text-text outline-none transition-colors duration-150 focus:border-line"
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
                    className="w-full resize-y rounded-panel border border-line-soft bg-transparent px-3 py-2.5 text-xs text-text outline-none focus:border-line"
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

            {tab === 'ai' && (
              <div className="flex max-w-xl flex-col gap-8">

                <Section title="Provider accounts" hint="Sign-in opens the provider's official OAuth flow. Credentials stay with the provider CLI on this device.">
                  <div className="flex flex-col gap-2.5">
                    {AI_PROVIDERS.map((provider) => {
                      const state = providerStatuses.find((item) => item.id === provider.id)
                      const connected = state?.connected === true
                      const connecting = state?.connecting === true
                      const unavailable = state?.available === false
                      return (
                        <div key={provider.id} className="flex items-center gap-3 rounded-panel border border-line-soft bg-bg-raise p-3.5">
                          <div className="grid h-8 w-8 flex-none place-items-center rounded-pill border border-line text-text" aria-label={`${provider.label} icon`}><provider.Icon size={16} /></div>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2 text-xs text-text"><span>{provider.label}</span>{connected && <span className="text-[10px] text-text-faint">Connected</span>}</div>
                            <p className="mt-1 truncate text-[10px] text-text-faint">{state?.detail || provider.hint}</p>
                            {unavailable && state?.installCommand && <code className="mt-1 block select-all truncate font-mono text-[9px] text-text-faint">{state.installCommand}</code>}
                          </div>
                          <button type="button" className={connected ? BTN_QUIET : BTN_PRIMARY} disabled={busy || connecting || unavailable} onClick={() => void connectProvider(provider.id)}>{unavailable ? 'CLI required' : connecting ? 'Waiting…' : connected ? 'Reconnect' : 'Connect via OAuth'}</button>
                        </div>
                      )
                    })}
                    {authPrompt && (
                      <div role={authPrompt.type === 'error' ? 'alert' : 'status'} className="flex flex-wrap items-center gap-2 rounded-panel border border-line-soft bg-bg-raise px-3 py-2 text-[11px] text-text-dim">
                        <span className="min-w-0 flex-1">{authPrompt.message}</span>
                        {authPrompt.userCode && <code className="select-all rounded-panel border border-line px-2 py-1 font-mono text-xs text-text">{authPrompt.userCode}</code>}
                        {authPrompt.url && <a href={authPrompt.url} target="_blank" rel="noreferrer" className="text-text underline underline-offset-2">Open sign-in page</a>}
                        {authPrompt.requiresInput && (
                          <form className="flex w-full items-center gap-2" onSubmit={(event) => { event.preventDefault(); void submitAuthCode() }}>
                            <input aria-label="OAuth code" value={authCode} onChange={(event) => setAuthCode(event.target.value)} placeholder="Paste OAuth code" autoComplete="off" className="h-8 min-w-0 flex-1 rounded-panel border border-line bg-transparent px-2 font-mono text-[10px] text-text outline-none focus:border-text-faint" />
                            <button type="submit" className={BTN_PRIMARY} disabled={busy || !authCode.trim()}>Continue</button>
                          </form>
                        )}
                      </div>
                    )}
                  </div>
                </Section>

                <Section title="Chat defaults" hint="These defaults are used for new chat widgets. You can override them directly in each chat.">
                  <label className="flex flex-col gap-1.5 text-[11px] text-text-dim">Provider
                    <select aria-label="Default AI provider" value={settings.aiProvider ?? 'chatgpt'} onChange={(event) => { const next = event.target.value as ChatProvider; void update({ aiProvider: next, aiModel: AI_MODELS[next][0] }) }} className="h-9 rounded-panel border border-line-soft bg-transparent px-2.5 text-xs text-text outline-none focus:border-line">
                      {AI_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
                    </select>
                  </label>
                  <label className="flex flex-col gap-1.5 text-[11px] text-text-dim">Model
                    <select aria-label="Default AI model" value={AI_MODELS[settings.aiProvider ?? 'chatgpt'].includes(settings.aiModel ?? '') ? settings.aiModel : AI_MODELS[settings.aiProvider ?? 'chatgpt'][0]} onChange={(event) => void update({ aiModel: event.target.value })} className="h-9 rounded-panel border border-line-soft bg-transparent px-2.5 text-xs text-text outline-none focus:border-line">
                      {AI_MODELS[settings.aiProvider ?? 'chatgpt'].map((model) => <option key={model} value={model}>{model}</option>)}
                    </select>
                  </label>
                  <div role="radiogroup" aria-label="Default reasoning effort" className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                    {(['low', 'medium', 'high'] as const).map((value) => <Choice key={value} selected={(settings.aiReasoningEffort ?? 'medium') === value} label={`${value[0].toUpperCase()}${value.slice(1)}`} hint={value === 'low' ? 'Fast replies' : value === 'medium' ? 'Balanced' : 'Deeper reasoning'} disabled={busy} onClick={() => void update({ aiReasoningEffort: value })} />)}
                  </div>
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

  // Nothing reset this when the menu closed, and openCodeWorkspace never
  // clears it on success — so a failed open left its message waiting inside
  // the panel, and the next time the user opened Folders it greeted them with
  // a stale error about an action they had already moved on from.
  useEffect(() => {
    if (foldersOpen) setFoldersError(null)
  }, [foldersOpen])

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
      const result = await window.api.workspace.createCodeWorkspace(undefined, folder || undefined)
      if (result && typeof result === 'object' && 'error' in result) {
        setFoldersError(result.error)
        return
      }
      if (result && typeof result === 'object' && 'id' in result) {
        setFoldersError(null)
      }
      refreshCodeWorkspaceGroups()
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
        const targetFolder = renameTarget.folder
        const result = await window.api.workspace.renameCodeWorkspace(renameTarget.id, nextName, targetFolder)
        if ('error' in result) {
          setFoldersError(result.error)
          return
        }
        setFoldersError(null)
        refreshCodeWorkspaceGroups()
      }
      setRenameTarget(null)
    } catch (err) {
      setFoldersError(err instanceof Error ? err.message : String(err))

    }
  }

  const renameCodeWorkspace = (folder: string, id: string, currentName: string): void => {
    openRename('code', id, currentName, folder)
  }

  const deleteCodeWorkspace = async (folder: string, id: string, name: string, isLast: boolean): Promise<void> => {
    const message = isLast
      ? `Delete workspace “${name}” and close this folder? Its saved sessions will no longer be available.`
      : `Delete workspace “${name}”? Its saved sessions will no longer be available.`
    const ok = await confirm(message, {
      title: 'Delete workspace',
      danger: true,
      confirmLabel: 'Delete'
    })
    if (!ok) return
    // Flushing saves the mounted sessions before the scope moves. Deleting a
    // workspace that is neither in this folder nor active changes neither, so
    // there is nothing to flush — skip the save and the reload it would cause.
    const activeId = codeWorkspaceGroups.find((group) => group.folder === folder)?.activeId
    const isCurrentActive = folder === workspaceDir && id === activeId
    if (isCurrentActive) window.dispatchEvent(new CustomEvent('orcspace:before-code-workspace-switch'))
    try {
      const result = await window.api.workspace.deleteCodeWorkspace(id, folder)
      if ('error' in result) setFoldersError(result.error)
      else refreshCodeWorkspaceGroups()
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
            className="absolute top-0 left-[calc(100%+10px)] z-[9500] w-72 max-w-[calc(100vw-70px)] max-h-[calc(100vh-120px)] overflow-auto rounded-panel border border-line bg-bg-panel p-2 shadow-2xl"
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
                    className={`group flex items-center gap-1 rounded-panel ${entry.path === workspaceDir ? 'bg-bg-hover' : ''}`}
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
                      className={`flex-none rounded-panel p-1 text-text-faint hover:bg-bg-hover hover:text-text ${entry.pinned ? 'text-accent' : ''}`}
                      title={entry.pinned ? 'Unpin' : 'Pin'}
                      aria-label={entry.pinned ? `Unpin ${entry.name}` : `Pin ${entry.name}`}
                      onClick={() => void pinRecent(entry.path)}
                    >
                      <Pin size={12} />
                    </button>
                    <button
                      className="flex-none rounded-panel p-1 text-text-faint hover:bg-bg-hover hover:text-text"
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
              <div role="alert" className="px-2 pt-1 pb-2 text-[11px] leading-snug text-danger">{foldersError}</div>
            )}
            <button
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-panel bg-accent px-3 py-2 text-xs font-semibold text-bg hover:opacity-90"
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
                  <div className="group/folder flex h-9 items-center gap-1 rounded-panel px-2" title={group.folder}>
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
                      className="grid h-7 w-7 flex-none place-items-center rounded-pill text-text-faint transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line disabled:opacity-40"
                    >
                      <Plus size={13} />
                    </button>
                  </div>
                  <div className="ml-[13px] border-l border-line-soft pl-2">
                    {group.workspaces.map((workspace) => {
                      const current = currentFolder && workspace.id === group.activeId
                      return (
                        <div key={workspace.id} className={`group flex min-w-0 items-center rounded-panel transition-colors ${current ? 'bg-bg-hover' : 'hover:bg-bg-hover'}`}>
                          <button
                            type="button"
                            data-testid={current ? 'current-workspace' : undefined}
                            aria-current={current ? 'page' : undefined}
                            className={`flex h-8 min-w-0 flex-1 items-center gap-2 rounded-panel px-2 text-left text-[11px] outline-none focus-visible:ring-1 focus-visible:ring-line ${current ? 'text-text' : 'text-text-dim'}`}
                            onClick={() => void selectCodeWorkspace(group.folder, workspace.id)}
                          >
                            <Code2 size={12} className="flex-none" />
                            <span className="min-w-0 truncate">{workspace.name}</span>
                          </button>
                          <button
                            type="button"
                            aria-label={`Rename ${workspace.name}`}
                            title="Rename workspace"
                            className="grid h-8 w-7 flex-none place-items-center rounded-panel text-text-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-bg-raise hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                            onClick={() => void renameCodeWorkspace(group.folder, workspace.id, workspace.name)}
                          >
                            <Pencil size={11} />
                          </button>
                          <button
                            type="button"
                            aria-label={`Delete ${workspace.name}`}
                            title="Delete workspace"
                            className="mr-0.5 grid h-8 w-7 flex-none place-items-center rounded-panel text-text-faint opacity-0 transition-colors group-hover:opacity-100 hover:bg-bg-raise hover:text-text focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
                            onClick={() => void deleteCodeWorkspace(group.folder, workspace.id, workspace.name, group.workspaces.length === 1)}
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
              <div className="rounded-panel border border-line bg-bg-panel px-3 py-4 text-center text-[11px] text-text-faint">
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
          className="mx-2 mb-2 flex h-9 flex-none items-center justify-center gap-2 rounded-panel border border-line bg-bg-hover px-3 text-[11px] font-medium text-text-dim transition-colors hover:bg-bg-raise hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        >
          <FolderPlus size={14} /> New folder
        </button>
      </div>
    )
  }

  const renameDialog = renameTarget ? createPortal(
    <div
      className="fixed inset-0 z-[60000] flex items-center justify-center bg-bg-raise/80 p-6 backdrop-blur-[2px]"
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
        className="pop-in flex w-[min(380px,calc(100vw-32px))] flex-col gap-4 rounded-panel border border-line-soft bg-bg-panel p-5 shadow-2xl"
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
            className="rounded-panel border border-line-soft bg-bg-raise px-3 py-2.5 text-xs font-normal tracking-normal text-text outline-none focus:border-line"
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
      className={`rail-shell rail relative z-[45000] flex flex-none flex-col gap-1 border-r border-line pt-10 pb-2 select-none bg-bg-raise ${expanded ? 'is-expanded w-[200px] items-stretch' : 'w-rail items-center'}`}
      style={{ WebkitAppRegion: 'drag', backgroundColor: monochrome.surface } as React.CSSProperties}
    >
      {!expanded && <button
        type="button"
        aria-label="Account"
        title={`${avatarName} · Account`}
        className="group absolute bottom-[52px] left-1/2 grid h-9 w-9 -translate-x-1/2 place-items-center rounded-pill border border-line bg-bg-raise p-[2px] transition-transform hover:scale-105 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-account'))}
      >
        <span className="grid h-full w-full place-items-center rounded-pill bg-bg-panel text-[10px] font-bold text-text">
          {avatarInitials}
        </span>
      </button>}
      {expanded ? renderExpanded() : (
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
            className="flex h-10 items-center gap-2.5 rounded-panel px-2 text-left text-text-dim transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
            onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-account'))}
            aria-label="Account"
          >
            <span className="grid h-7 w-7 flex-none place-items-center rounded-pill border border-line bg-bg-panel text-[9px] font-bold text-text">{avatarInitials}</span>
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
            className="flex h-9 items-center gap-2.5 rounded-panel px-2 text-[11px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-line"
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
