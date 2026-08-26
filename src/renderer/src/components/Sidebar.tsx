import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CreditCard, FileText, FolderOpen, KanbanSquare, Palette, Pin, Settings, Terminal, User, UserRound, X } from 'lucide-react'
import type { RecentDir, UserRole } from '../../../preload/index.d'
import { useFocusTrap } from '../hooks/useFocusTrap'
import { THEMES, useTheme } from '../theme'
import { useSettings } from '../hooks/useSettings'
import { VerifiedBadge } from './VerifiedBadge'

interface Props {
  workspaceDir: string | null
  managerId: string | null
  boardOpen: boolean
  brainOpen: boolean
  taskCount: number
  onNewTerminal(): void
  onToggleBoard(): void
  onToggleBrain(): void
  onPickDir(): void
}

function IconButton({
  label,
  active,
  danger,
  badge,
  testId,
  onClick,
  children
}: {
  label: string
  active?: boolean
  danger?: boolean
  badge?: number
  testId?: string
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
    >
      {children}
      {badge ? (
        <span className="absolute top-0.5 right-0.5 min-w-[15px] rounded-full bg-accent px-1 text-[9px] leading-[15px] font-semibold text-black">
          {badge}
        </span>
      ) : null}
      <span className="pointer-events-none absolute left-[calc(100%+10px)] z-[900] max-w-[min(20rem,calc(100vw-72px))] overflow-hidden rounded-[10px] border border-line bg-bg-panel px-2.5 py-1.5 text-[11px] text-ellipsis whitespace-nowrap text-text opacity-0 transition-all duration-150 -translate-x-1 group-hover:translate-x-0 group-hover:opacity-100 group-focus-visible:translate-x-0 group-focus-visible:opacity-100">
        {label}
      </span>
    </button>
  )
}

/** Full settings dialog: portaled to body so the rail's drag region / stacking context cannot clip it. */
const LINK_SYNTAX: { id: 'wiki' | 'dollar' | 'both'; label: string; hint: string }[] = [
  { id: 'both', label: 'Both', hint: '[[Title]] or $Title' },
  { id: 'wiki', label: 'Wiki', hint: '[[Note Title]]' },
  { id: 'dollar', label: 'Dollar', hint: '$Note-Title' }
]

const ROLES: { id: UserRole; label: string; hint: string }[] = [
  {
    id: 'lead',
    label: 'Lead (Orchestrator)',
    hint: 'Full control over kanban tasks, agent orchestration, and system management.'
  },
  {
    id: 'member',
    label: 'Member (Contributor)',
    hint: 'Works on assigned tasks and notes without modifying orchestration roles.'
  }
]

const SETTINGS_TABS = [
  { id: 'appearance' as const, label: 'Appearance', Icon: Palette },
  { id: 'account' as const, label: 'Account', Icon: UserRound },
  { id: 'plans' as const, label: 'Billing', Icon: CreditCard },
]

const FAVORITE_WIDGETS = [
  ['terminal', 'Terminal', 'Shell in the current workspace'],
  ['files', 'Files', 'Browse workspace files'],
  ['sys-monitor', 'System Monitor', 'CPU, RAM and processes'],
  ['note', 'Note', 'Quick notes on the canvas'],
  ['timer', 'Timer', 'Countdown or stopwatch'],
  ['planner', 'Planner', 'Daily agenda and checklist'],
  ['browser', 'Browser', 'Embedded web page'],
  ['links', 'Links', 'Saved links'],
  ['music-player', 'Music Player', 'Stream YouTube, Yandex Music, Spotify or MP3 links'],
  ['id-generator', 'ID Generator', 'Random identifiers']
] as const

function SettingsModal({
  workspaceDir,
  managerId
}: {
  workspaceDir?: string | null
  managerId?: string | null
}): React.JSX.Element {
  const { theme, setTheme, background, dim, setDim, blur, setBlur, pickBackground, clearBackground, error } = useTheme()
  const { settings, update, error: settingsError } = useSettings()
  const [tab, setTab] = useState<'appearance' | 'account' | 'plans'>('appearance')
  const [userName, setUserName] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const dialogRef = useRef<HTMLDivElement>(null)
  useFocusTrap(dialogRef, open)

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
    const openAccount = (): void => {
      setTab('account')
      setOpen(true)
    }
    window.addEventListener('orcspace:open-account', openAccount)
    return () => {
      window.removeEventListener('orcspace:open-account', openAccount)
    }
  }, [])

  const saveAccount = async (): Promise<void> => {
    setBusy(true)
    try {
      await update({
        userName: userName.trim() || 'you'
      })
      setNotice('Account settings saved.')
    } catch (err) {
      setNotice(`Failed to save account: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setBusy(false)
    }
  }


  const dialog =
    open &&
    // Portal layer sits above the rail (z-45000) and the Browser/Code panes
    // (z-40000): this modal is opened from the rail in every view, so painting
    // it beneath either made Settings/Account look dead there (UI-audit P0).
    createPortal(
        <div
          className="fixed top-10 inset-x-0 bottom-0 z-[50000] flex items-center justify-center p-6 backdrop-blur-sm"
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) setOpen(false)
        }}
      >
        <div
          ref={dialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="Settings"
          data-testid="settings-modal"
          className="flex max-h-[min(720px,calc(100vh-80px))] w-[min(900px,calc(100vw-48px))] flex-col overflow-hidden rounded-[16px] border border-line bg-bg-panel shadow-2xl sm:flex-row glass:bg-bg-panel/90"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <nav className="flex flex-none gap-1 overflow-x-auto border-b border-line-soft bg-bg-raise/30 p-2 sm:block sm:w-44 sm:border-r sm:border-b-0 sm:p-3">
            <div className="hidden px-2 pb-4 text-sm font-semibold text-text sm:block">Settings</div>
            {SETTINGS_TABS.map(({ id, label, Icon }) => (
              <button
                key={id}
                data-testid={`settings-tab-${id}`}
                aria-current={tab === id ? 'true' : undefined}
                className={`flex flex-none items-center gap-2 rounded-[9px] px-2.5 py-2 text-left text-xs sm:mb-1 sm:w-full ${tab === id ? 'bg-bg-hover text-accent' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}
                onClick={() => setTab(id)}
              >
                <Icon size={14} strokeWidth={1.8} />
                {label}
              </button>
            ))}
          </nav>
          <main className="min-w-0 flex-1 overflow-auto p-5">
            <div className="mb-5 flex items-center justify-between">
              <h2 className="text-lg font-semibold text-text">
                {tab === 'appearance' ? 'Appearance' : tab === 'account' ? 'Account' : 'Billing'}
              </h2>
              <button
                className="rounded-[8px] p-1.5 text-text-dim hover:bg-bg-hover hover:text-text"
                onClick={() => setOpen(false)}
                aria-label="Close"
              >
                <X size={17} />
              </button>
            </div>

            {tab === 'appearance' && (
              <div className="max-w-xl space-y-5">
                <div>
                  <div className="mb-2 text-xs font-semibold text-text">Theme</div>
                  <div className="grid grid-cols-2 gap-2">
                    {THEMES.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={theme === item.id}
                        className={`rounded-[10px] border p-3 text-left ${theme === item.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-bg-hover'}`}
                        onClick={() => {
                          setTheme(item.id)
                          if (item.id === 'photo' && !background) void pickBackground()
                        }}
                      >
                        <div className="text-xs text-text">{item.label}</div>
                        <div className="mt-1 text-[10px] text-text-faint">{item.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold text-text">Right-click menu</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-text-faint">
                    Choose which widgets appear when you right-click the canvas.
                  </p>
                  <div className="space-y-1">
                    {FAVORITE_WIDGETS.map(([id, label, hint]) => {
                      const selected = (settings.favoriteWidgets ?? []).includes(id)
                      return (
                        <label key={id} className="flex cursor-pointer items-center gap-2 rounded-[8px] px-2 py-1.5 text-xs text-text hover:bg-bg-hover">
                          <input
                            type="checkbox"
                            checked={selected}
                            onChange={() => void update({ favoriteWidgets: selected ? (settings.favoriteWidgets ?? []).filter((kind) => kind !== id) : [...(settings.favoriteWidgets ?? []), id] })}
                            className="accent-accent"
                          />
                          <span className="min-w-0 flex-1">{label}</span>
                          <span className="text-[10px] text-text-faint">{hint}</span>
                        </label>
                      )
                    })}
                  </div>
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold text-text">Background</div>
                  {background ? (
                    <div
                      className="mb-2 h-28 rounded-[10px] bg-cover bg-center"
                      style={{ backgroundImage: `url("${background}")` }}
                    />
                  ) : (
                    <div className="mb-2 rounded-[10px] border border-dashed border-line px-3 py-6 text-center text-xs text-text-faint">
                      No background selected
                    </div>
                  )}
                  <div className="flex gap-2">
                    <button
                      className="rounded-[9px] border border-line px-3 py-2 text-xs text-text hover:bg-bg-hover"
                      onClick={() => void pickBackground()}
                    >
                      Choose Background
                    </button>
                    {background && (
                      <button
                        className="rounded-[9px] border border-line px-3 py-2 text-xs text-text-dim hover:bg-bg-hover"
                        onClick={clearBackground}
                      >
                        Remove Background
                      </button>
                    )}
                  </div>
                  <label className="mt-4 block text-xs text-text-dim">
                    Blur: {blur}%
                    <input
                      className="mt-2 w-full accent-white"
                      type="range"
                      min={0}
                      max={90}
                      step={5}
                      value={blur}
                      onChange={(event) => setBlur(Number(event.target.value))}
                    />
                  </label>
                  <label className="mt-4 block text-xs text-text-dim">
                    Dim: {dim}%
                    <input
                      className="mt-2 w-full accent-white"
                      type="range"
                      min={0}
                      max={90}
                      step={5}
                      value={dim}
                      onChange={(event) => setDim(Number(event.target.value))}
                    />
                  </label>
                  {error && <p className="mt-2 text-xs text-danger">{error}</p>}
                </div>
                <div>
                  <div className="mb-2 text-xs font-semibold text-text">Note links</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-text-faint">
                    How Second Brain turns typed references into links between notes.
                  </p>
                  <div className="grid grid-cols-3 gap-2">
                    {LINK_SYNTAX.map((item) => (
                      <button
                        key={item.id}
                        aria-pressed={settings.linkSyntax === item.id}
                        className={`rounded-[10px] border p-3 text-left ${settings.linkSyntax === item.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-bg-hover'}`}
                        onClick={() => void update({ linkSyntax: item.id })}
                      >
                        <div className="text-xs text-text">{item.label}</div>
                        <div className="mt-1 font-mono text-[10px] text-text-faint">{item.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {tab === 'account' && (
              <div className="max-w-xl space-y-4">
                {/* Profile Card */}
                <section className="rounded-[12px] border border-line-soft bg-bg-raise/40 p-4">
                  <div className="flex items-center gap-3.5">
                    <div className="grid h-12 w-12 flex-none place-items-center rounded-full bg-accent text-base font-bold text-black shadow-md select-none">
                      {(userName.trim() || settings.userName || 'you').slice(0, 2).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-semibold text-text">
                          {userName.trim() || settings.userName || 'you'}
                        </span>
                        {settings.plan === 'plus' && <VerifiedBadge size={15} />}
                        <span className="rounded-full bg-accent/15 px-2 py-0.5 text-[10px] font-semibold text-accent">
                          {settings.role === 'lead' ? 'Lead' : 'Member'}
                        </span>
                      </div>
                      <p className="mt-0.5 text-[11px] text-text-faint">
                        Local Operator ID: <span className="font-mono text-text-dim">user</span>
                      </p>
                    </div>
                  </div>
                </section>

                {/* Display Name */}
                <div>
                  <div className="mb-1 text-xs font-semibold text-text">Display Name / Assignee</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-text-faint">
                    Shown as the assignee on Kanban cards and as the author of notes you create.
                  </p>
                  <input
                    className="w-full rounded-lg border border-line bg-bg-panel px-2.5 py-2 text-xs text-text outline-none focus:border-text-faint"
                    type="text"
                    maxLength={40}
                    value={userName}
                    onChange={(event) => setUserName(event.target.value)}
                    placeholder="e.g. you"
                  />
                </div>

                {/* Workspace Role */}
                <div>
                  <div className="mb-1 text-xs font-semibold text-text">Workspace Role</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-text-faint">
                    Determines your orchestration and editing capabilities across the workspace.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    {ROLES.map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-pressed={settings.role === item.id}
                        className={`rounded-[10px] border p-3 text-left transition-colors ${settings.role === item.id ? 'border-accent bg-accent/10' : 'border-line hover:bg-bg-hover'}`}
                        onClick={() => {
                          void update({ role: item.id })
                          setNotice(`Role switched to ${item.label}.`)
                        }}
                      >
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-medium text-text">{item.label}</span>
                          {settings.role === item.id && (
                            <span className="text-[10px] font-semibold text-accent">Active</span>
                          )}
                        </div>
                        <div className="mt-1 text-[10px] leading-relaxed text-text-faint">{item.hint}</div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Subscription Plan */}
                <div>
                  <div className="mb-1 text-xs font-semibold text-text">Subscription Plan</div>
                  <p className="mb-2 text-[11px] leading-relaxed text-text-faint">
                    Choose your plan tier to unlock verified status and extended capabilities.
                  </p>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      className={`rounded-[10px] border p-3 text-left transition-colors ${settings.plan !== 'plus' ? 'border-accent bg-accent/15 shadow-sm ring-1 ring-accent/30' : 'border-line hover:bg-bg-hover'}`}
                      onClick={() => {
                        void update({ plan: 'free' })
                        setNotice('Switched to Free plan.')
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-medium text-text">Free ($0)</span>
                        {settings.plan !== 'plus' && (
                          <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-bold text-black">Active ✓</span>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] leading-relaxed text-text-faint">Standard local tools</div>
                    </button>

                    <button
                      type="button"
                      className={`rounded-[10px] border p-3 text-left transition-colors ${settings.plan === 'plus' ? 'border-[#38bdf8] bg-[#38bdf8]/15 shadow-sm ring-1 ring-[#38bdf8]/40' : 'border-line hover:bg-bg-hover'}`}
                      onClick={() => {
                        void update({ plan: 'plus' })
                        setNotice('Welcome to OrcSpace Plus! Verified badge activated.')
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className="flex items-center gap-1.5 text-xs font-medium text-text">
                          OrcSpace Plus ($9.99/mo)
                          <VerifiedBadge size={14} />
                        </span>
                        {settings.plan === 'plus' ? (
                          <span className="rounded-full bg-[#38bdf8] px-2 py-0.5 text-[10px] font-bold text-black">Active ✓</span>
                        ) : (
                          <span className="rounded-full bg-[#38bdf8]/20 px-2 py-0.5 text-[10px] font-bold text-[#38bdf8]">Select</span>
                        )}
                      </div>
                      <div className="mt-1 text-[10px] leading-relaxed text-text-faint">Verified badge + Full power</div>
                    </button>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1">
                  <button
                    className="rounded-[9px] bg-accent px-4 py-2 text-xs font-semibold text-black hover:bg-white disabled:opacity-50"
                    disabled={busy || !userName.trim() || userName.trim() === settings.userName}
                    onClick={() => void saveAccount()}
                  >
                    Save Account Settings
                  </button>
                </div>

                {/* Workspace Session Info */}
                <section className="rounded-[12px] border border-line-soft bg-bg-raise/20 p-3 text-[11px] text-text-dim">
                  <div className="mb-1.5 font-semibold text-text">Workspace Session Info</div>
                  <div className="space-y-1 text-text-faint">
                    <div className="truncate">
                      Active Folder: <span className="font-mono text-text-dim">{workspaceDir || 'None'}</span>
                    </div>
                    <div>
                      Lead Manager: <span className="font-mono text-text-dim">{managerId || 'None'}</span>
                    </div>
                    <div>
                      Storage Security: <span className="text-ok">Credentials encrypted locally via OS safeStorage</span>
                    </div>
                  </div>
                </section>
              </div>
            )}


            {tab === 'plans' && (
              <div className="max-w-xl space-y-4">
                {/* Active Plan Status Banner with Quick Switcher */}
                <section
                  className={`rounded-[12px] border p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 transition-all ${
                    settings.plan === 'plus'
                      ? 'border-[#38bdf8]/40 bg-[#38bdf8]/10'
                      : 'border-line-soft bg-bg-raise/30'
                  }`}
                >
                  <div className="flex items-center gap-2.5">
                    {settings.plan === 'plus' ? (
                      <div className="flex items-center gap-2.5">
                        <VerifiedBadge size={22} />
                        <div>
                          <div className="flex items-center gap-1.5 text-xs font-semibold text-text">
                            OrcSpace Plus Active
                            <span className="rounded-full bg-[#38bdf8]/20 px-2 py-0.5 text-[10px] font-bold text-[#38bdf8]">
                              $9.99 / mo
                            </span>
                          </div>
                          <p className="mt-0.5 text-[11px] text-text-dim">
                            Blue verified checkmark is active on your profile and workspace.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <div>
                        <div className="text-xs font-semibold text-text">Free Plan Active</div>
                        <p className="mt-0.5 text-[11px] text-text-faint">
                          Click below to immediately select Free ($0) or OrcSpace Plus ($9.99/mo).
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 flex-none">
                    <button
                      type="button"
                      className={`rounded-lg px-3 py-1.5 text-xs transition-colors ${
                        settings.plan !== 'plus'
                          ? 'bg-accent font-bold text-black shadow-sm'
                          : 'border border-line text-text-dim hover:text-text hover:bg-bg-hover'
                      }`}
                      onClick={() => {
                        void update({ plan: 'free' })
                        setNotice('Switched to Free plan.')
                      }}
                    >
                      Free ($0)
                    </button>
                    <button
                      type="button"
                      className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${
                        settings.plan === 'plus'
                          ? 'bg-[#38bdf8] font-bold text-black shadow-[0_0_10px_rgba(56,189,248,0.4)]'
                          : 'border border-[#38bdf8]/40 text-[#38bdf8] hover:bg-[#38bdf8]/15'
                      }`}
                      onClick={() => {
                        void update({ plan: 'plus' })
                        setNotice('Welcome to OrcSpace Plus! Verified badge activated.')
                      }}
                    >
                      <VerifiedBadge size={13} />
                      Plus ($9.99/mo)
                    </button>
                  </div>
                </section>

                {/* Plan Cards Grid - Both fully interactive and selectable */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  {/* Free Plan Card */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      void update({ plan: 'free' })
                      setNotice('Switched to Free plan.')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void update({ plan: 'free' })
                        setNotice('Switched to Free plan.')
                      }
                    }}
                    className={`group cursor-pointer select-none flex flex-col justify-between rounded-[12px] border p-4 text-left transition-all ${
                      settings.plan !== 'plus'
                        ? 'border-accent bg-accent/10 shadow-md ring-1 ring-accent/30'
                        : 'border-line-soft bg-bg-raise/20 hover:border-line hover:bg-bg-raise/40'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold text-text">Free Plan</h3>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                            settings.plan !== 'plus'
                              ? 'bg-accent text-black font-bold'
                              : 'border border-line text-text-faint group-hover:text-text group-hover:border-text-faint'
                          }`}
                        >
                          {settings.plan !== 'plus' ? 'Selected ✓' : 'Select'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-text-faint">For basic local and solo agent workflows</p>
                      <div className="mt-3 flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-text">$0</span>
                        <span className="text-xs text-text-faint">/ month</span>
                      </div>
                      <ul className="mt-4 space-y-2 text-[11px] text-text-dim">
                        <li className="flex items-center gap-2">
                          <span className="text-text-faint">•</span> Up to 3 active terminals
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-text-faint">•</span> Second Brain notes & graph
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-text-faint">•</span> Basic MCP tools
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-text-faint">•</span> Standard local AI models
                        </li>
                      </ul>
                    </div>

                    <div
                      className={`mt-5 w-full rounded-[9px] border px-3 py-2 text-center text-xs font-semibold transition-colors ${
                        settings.plan !== 'plus'
                          ? 'border-accent/40 bg-accent/20 text-accent font-bold'
                          : 'border-line bg-bg-panel text-text-dim group-hover:text-text group-hover:border-text-faint'
                      }`}
                    >
                      {settings.plan !== 'plus' ? 'Current Plan ✓' : 'Switch to Free'}
                    </div>
                  </div>

                  {/* OrcSpace Plus Plan Card */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      void update({ plan: 'plus' })
                      setNotice('Welcome to OrcSpace Plus! Verified badge activated.')
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        void update({ plan: 'plus' })
                        setNotice('Welcome to OrcSpace Plus! Verified badge activated.')
                      }
                    }}
                    className={`group relative cursor-pointer select-none flex flex-col justify-between rounded-[12px] border p-4 text-left transition-all ${
                      settings.plan === 'plus'
                        ? 'border-[#38bdf8] bg-gradient-to-b from-[#38bdf826] to-bg-panel shadow-[0_4px_6px_-1px_rgba(56,189,248,0.1),0_2px_4px_-2px_rgba(56,189,248,0.1)] ring-1 ring-[#38bdf8]/40'
                        : 'border-[#38bdf8]/30 bg-bg-raise/30 hover:border-[#38bdf8]/70 hover:bg-bg-raise/50'
                    }`}
                  >
                    <div>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <h3 className="text-sm font-semibold text-text">OrcSpace Plus</h3>
                          <VerifiedBadge size={16} />
                        </div>
                        <span
                          className={`rounded-full px-2 py-0.5 text-[10px] font-bold transition-colors ${
                            settings.plan === 'plus'
                              ? 'bg-[#38bdf8] text-black'
                              : 'bg-[#38bdf8]/20 text-[#38bdf8] group-hover:bg-[#38bdf8] group-hover:text-black'
                          }`}
                        >
                          {settings.plan === 'plus' ? 'Active ✓' : 'Select ($9.99/mo)'}
                        </span>
                      </div>
                      <p className="mt-1 text-[11px] text-text-faint">Full orchestration power & verified status</p>
                      <div className="mt-3 flex items-baseline gap-1">
                        <span className="text-2xl font-bold text-[#38bdf8]">$9.99</span>
                        <span className="text-xs text-text-faint">/ month</span>
                      </div>
                      <ul className="mt-4 space-y-2 text-[11px] text-text">
                        <li className="flex items-center gap-2">
                          <VerifiedBadge size={13} />
                          <span className="font-medium text-[#38bdf8]">Blue Verified Checkmark Badge</span>
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-[#38bdf8]">•</span> Unlimited terminals & workspaces
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-[#38bdf8]">•</span> Autonomous agent orchestration
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-[#38bdf8]">•</span> Real-time voice & audio pipeline
                        </li>
                        <li className="flex items-center gap-2">
                          <span className="text-[#38bdf8]">•</span> Full MCP protocol
                        </li>
                      </ul>
                    </div>

                    <div
                      className={`mt-5 w-full rounded-[9px] px-3 py-2 text-center text-xs font-semibold transition-colors ${
                        settings.plan === 'plus'
                          ? 'bg-[#38bdf8] text-black shadow-[0_0_12px_rgba(56,189,248,0.4)]'
                          : 'bg-[#38bdf8]/80 text-black group-hover:bg-[#38bdf8]'
                      }`}
                    >
                      {settings.plan === 'plus' ? 'Active Subscription ✓' : 'Subscribe for $9.99 / month'}
                    </div>
                  </div>
                </div>
              </div>
            )}
            {notice && <p className="mt-4 text-xs text-text-dim">{notice}</p>}
            {settingsError && (
              <p role="alert" className="mt-2 text-xs text-danger">
                Failed to save settings: {settingsError}
              </p>
            )}
          </main>
        </div>
      </div>,
      document.body
    )

  return (
    <>
      <IconButton label="Settings" testId="rail-settings" onClick={() => setOpen(true)}>
        <Settings size={17} />
      </IconButton>
      {dialog}
    </>
  )
}

// Memoized: the canvas re-renders on every camera frame, and this rail sits
// next to it in the same tree. All props are stable primitives or stable
// callbacks (App keeps them in useCallback), so the memo lets the rail skip
// every pan/zoom frame it has no stake in (PERF-rail-memo).
export default React.memo(function Sidebar({
  workspaceDir,
  managerId,
  boardOpen,
  brainOpen,
  taskCount,
  onNewTerminal,
  onToggleBoard,
  onToggleBrain,
  onPickDir
}: Props): React.JSX.Element {
  const { settings } = useSettings()
  const [recent, setRecent] = useState<RecentDir[]>([])
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [foldersError, setFoldersError] = useState<string | null>(null)
  const foldersRef = useRef<HTMLDivElement>(null)
  const foldersMenuRef = useRef<HTMLDivElement>(null)
  useFocusTrap(foldersMenuRef, foldersOpen)
  const dirName = workspaceDir ? workspaceDir.split(/[\\/]/).filter(Boolean).pop() : null
  const avatarName = settings.userName?.trim() || 'you'
  const avatarInitials = avatarName.slice(0, 2).toUpperCase()

  // Remembered folders live in the main process, so mirror them live.
  useEffect(() => {
    void window.api.workspace
      .recent()
      .then(setRecent)
      .catch((err) => console.warn('workspace:recent failed', err))
    return window.api.workspace.onRecentChange(setRecent)
  }, [])

  useEffect(() => {
    if (!foldersOpen) return
    const onDown = (e: MouseEvent): void => {
      if (foldersRef.current && !foldersRef.current.contains(e.target as Node)) setFoldersOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setFoldersOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [foldersOpen])

  const open = async (path: string): Promise<void> => {
    // Both a bus `{ error }` reply and a rejected invoke (deleted folder,
    // unreachable drive) must surface — an uncaught reject would only hit the
    // global console handler and the menu would silently stay open.
    try {
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

  const RAIL_ITEM_IDS = ['terminal', 'board', 'notes', 'folders'] as const
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
      // ignore malformed storage
    }
    return [...RAIL_ITEM_IDS]
  })
  const dragIdRef = useRef<RailItemId | null>(null)

  const reorder = (target: RailItemId): void => {
    const dragged = dragIdRef.current
    if (!dragged || dragged === target) return
    setOrder((prev) => {
      const next = prev.filter((id) => id !== dragged)
      next.splice(next.indexOf(target), 0, dragged)
      localStorage.setItem('rail-order', JSON.stringify(next))
      return next
    })
  }

  const railItems: Record<RailItemId, React.ReactNode> = {
    terminal: (
      <IconButton label="New Terminal" testId="rail-new-terminal" onClick={onNewTerminal}>
        <Terminal size={17} />
      </IconButton>
    ),
    board: (
      <IconButton label="Task Board" testId="rail-board" active={boardOpen} badge={taskCount} onClick={onToggleBoard}>
        <KanbanSquare size={17} />
      </IconButton>
    ),
    notes: (
      <IconButton label="Memory" testId="rail-notes" active={brainOpen} onClick={onToggleBrain}>
        <FileText size={17} />
      </IconButton>
    ),
    folders: (
      <div className="relative" ref={foldersRef}>
        <IconButton
          label={workspaceDir ? `Folders · current: ${dirName}` : 'Workspace Folders'}
          testId="rail-folders"
          active={Boolean(workspaceDir)}
          onClick={() => setFoldersOpen((v) => !v)}
        >
          <FolderOpen size={17} />
        </IconButton>

        {foldersOpen && (
          <div
            ref={foldersMenuRef}
            role="dialog"
            aria-modal="true"
            aria-label="Workspace Folders"
            className="absolute top-0 left-[calc(100%+10px)] z-[900] w-72 max-w-[calc(100vw-70px)] rounded-[10px] border border-line bg-bg-panel p-2 shadow-2xl glass:bg-bg-panel/85 glass:backdrop-blur-2xl"
          >
            <div className="px-1.5 pt-1 pb-2 text-[10px] tracking-wider text-text-faint uppercase">Workspace Folders</div>
            <div className="flex max-h-72 flex-col gap-1 overflow-auto">
              {recent.map((entry) => (
                <div
                  key={entry.path}
                  className={`group flex items-center gap-1 rounded-[10px] ${entry.path === workspaceDir ? 'bg-bg-hover' : ''}`}
                  title={entry.path}
                >
                  <button className="min-w-0 flex-1 px-2 py-1.5 text-left" onClick={() => void open(entry.path)}>
                    <b className="block truncate text-xs font-semibold text-text">{entry.name}</b>
                    <span className="block truncate text-[10px] text-text-faint">{entry.path}</span>
                  </button>
                  <button
                    className={`flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text ${entry.pinned ? 'text-accent' : ''}`}
                    title={entry.pinned ? 'Unpin' : 'Pin'}
                    onClick={() => void pinRecent(entry.path)}
                  >
                    <Pin size={12} />
                  </button>
                  <button
                    className="flex-none rounded-[10px] p-1 text-text-faint hover:bg-bg-hover hover:text-text"
                    title="Remove from recent"
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
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-[10px] bg-accent px-3 py-2 text-xs font-semibold text-black hover:bg-white"
              onClick={() => {
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

  return (
    <aside
      className="rail-shell rail relative z-[45000] flex w-rail flex-none flex-col items-center gap-1.5 border-r border-line pt-10 pb-2.5 glass:border-line-soft select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      <button
        type="button"
        aria-label="Account"
        title={`${avatarName} · Account`}
        className={`group absolute bottom-[52px] grid h-9 w-9 place-items-center rounded-full p-[2px] transition-transform hover:scale-105 ${
          settings.plan === 'plus'
            ? 'bg-[#2563eb]'
            : 'bg-line-soft'
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        onClick={() => window.dispatchEvent(new CustomEvent('orcspace:open-account'))}
      >
        <span className="grid h-full w-full place-items-center rounded-full bg-bg-panel text-[10px] font-bold text-text">
          {avatarInitials}
        </span>
      </button>
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
      <SettingsModal workspaceDir={workspaceDir} managerId={managerId} />
    </aside>
  )
})
