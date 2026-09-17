import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Copy,
  Eye,
  EyeOff,
  GitBranch,
  LayoutGrid,
  Minus,
  PanelLeft,
  Square,
  X
} from 'lucide-react'
import type { GitBranch as GitBranchInfo, GitCommit as GitCommitInfo, GitStatus } from '../../../preload/index.d'
import { IS_MAC } from '../lib/platform'
import type { ArrangeMode } from '../lib/canvasLayout'
import type { CodeLayoutMode } from '../lib/codeLayout'

export type WorkView = 'canvas' | 'code'







const ISLAND =
  'flex h-10 items-center gap-1 border-0 bg-transparent p-0'

const VIEW_SWITCH =
  'flex h-[30px] items-center gap-0 rounded-pill border border-bg-raise bg-bg p-[3px]'

const VIEW_TAB =
  'flex h-[24px] flex-none items-center rounded-pill px-[11px] text-[12px] font-medium transition-colors duration-150 cursor-pointer select-none'

const VIEW_TAB_ACTIVE = 'bg-bg-hover text-white font-semibold'
const VIEW_TAB_INACTIVE = 'bg-bg text-white/60 hover:text-white hover:bg-line'



const ICON =
  'grid h-10 w-[46px] flex-none place-items-center rounded-bar border-0 transition-colors duration-150 cursor-pointer'
const QUIET = 'text-text-faint hover:bg-bg-hover hover:text-text'

const CANVAS_ARRANGE_ITEMS: ReadonlyArray<{ mode: ArrangeMode; label: string; hint: string }> = [
  { mode: 'grid', label: 'Grid', hint: 'Equal tiles in a square grid' },
  { mode: 'tiny', label: 'Tiny', hint: 'Small tiles, as many per row as fit' },
  { mode: 'focus', label: 'Focus', hint: 'Active widget large, the rest beside it' },
  { mode: 'free', label: 'Free', hint: 'Back to where you dragged them' }
]

// Code lays its terminals out in a CSS grid rather than on free coordinates,
// so the modes differ: Auto is the per-count layout the view ships with, and
// there is nothing for Tiny or Free to mean.
const CODE_ARRANGE_ITEMS: ReadonlyArray<{ mode: CodeLayoutMode; label: string; hint: string }> = [
  { mode: 'auto', label: 'Auto', hint: 'Built-in layout for the session count' },
  { mode: 'grid', label: 'Grid', hint: 'Equal cards in a square grid' },
  { mode: 'columns', label: 'Columns', hint: 'One column per terminal' },
  { mode: 'rows', label: 'Rows', hint: 'One row per terminal' },
  { mode: 'focus', label: 'Focus', hint: 'Last used terminal large, rest beside it' }
]

interface Props {
  activeView: WorkView
  onViewChange: (view: WorkView) => void
  arrangeMode: ArrangeMode
  onArrange: (mode: ArrangeMode) => void
  codeLayoutMode: CodeLayoutMode
  onCodeLayout: (mode: CodeLayoutMode) => void
  codeSidebarCollapsed: boolean
  onToggleCodeSidebar: () => void
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  terminalsFlipped: boolean
  onToggleTerminalsFlipped: () => void
}

export default React.memo(function TitleBar({
  activeView,
  onViewChange,
  arrangeMode,
  onArrange,
  codeLayoutMode,
  onCodeLayout,
  codeSidebarCollapsed,
  onToggleCodeSidebar,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  terminalsFlipped,
  onToggleTerminalsFlipped
}: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitOpen, setGitOpen] = useState(false)
  const [gitQuery, setGitQuery] = useState('')
  const [gitBranches, setGitBranches] = useState<GitBranchInfo[]>([])
  const [gitCommits, setGitCommits] = useState<GitCommitInfo[]>([])
  const [gitHead, setGitHead] = useState('')
  const [gitLoading, setGitLoading] = useState(false)
  const [gitError, setGitError] = useState<string | null>(null)
  const [gitNotice, setGitNotice] = useState<string | null>(null)
  const [gitBusyRef, setGitBusyRef] = useState<string | null>(null)
  const [arrangeOpen, setArrangeOpen] = useState(false)
  const rightIslandRef = useRef<HTMLDivElement>(null)

  // Each view arranges different things, so switching views closes the menu
  // rather than leaving the other view's options on screen.
  useEffect(() => {
    setArrangeOpen(false)
  }, [activeView])

  useEffect(() => {
    if (!arrangeOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rightIslandRef.current && !rightIslandRef.current.contains(e.target as Node)) {
        setArrangeOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setArrangeOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [arrangeOpen])

  useEffect(() => {
    if (!gitOpen) return
    const onDown = (e: MouseEvent): void => {
      if (rightIslandRef.current && !rightIslandRef.current.contains(e.target as Node)) {
        setGitOpen(false)
      }
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setGitOpen(false)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [gitOpen])

  useEffect(() => {

    void window.api.window.isMaximized().then(setMaximized).catch(() => setMaximized(false))
    return window.api.window.onMaximizeChange(setMaximized)
  }, [])

  const gitSeq = useRef(0)
  const gitAbortRef = useRef<AbortController | null>(null)
  const refreshGit = useCallback(async (): Promise<void> => {
    gitAbortRef.current?.abort()
    const ctrl = new AbortController()
    gitAbortRef.current = ctrl
    const seq = ++gitSeq.current
    try {
      const res = (await window.api.git.status()) as GitStatus | { error: string; code?: string }
      if (ctrl.signal.aborted || seq !== gitSeq.current) return
      if (res && !('error' in res)) {
        setGitStatus(res as GitStatus)
      } else {
        const code = (res as { code?: string })?.code
        if (code === 'cancelled') return
        if ((res as { error?: string }).error) {
          setGitStatus(res as unknown as GitStatus)
        } else {
          setGitStatus(null)
        }
      }
    } catch {
      if (ctrl.signal.aborted || seq !== gitSeq.current) return
      setGitStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshGit()
    let timer: ReturnType<typeof setTimeout>
    let cancelled = false
    const schedule = (): void => {
      if (cancelled) return
      const delay = document.hidden || !document.hasFocus() ? 30_000 : 8_000
      timer = setTimeout(() => {
        if (cancelled) return
        if (!document.hidden) void refreshGit()
        schedule()
      }, delay)
    }
    schedule()
    const onVisible = (): void => {
      if (!document.hidden) void refreshGit()
    }
    const onFocus = (): void => {
      void refreshGit()
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onFocus)
    const offDir = window.api.workspace.onDirChange(() => void refreshGit())
    return () => {
      cancelled = true
      clearTimeout(timer)
      gitAbortRef.current?.abort()
      gitSeq.current += 1
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      offDir()
    }
  }, [refreshGit])

  const dirtyCount = gitStatus
    ? (gitStatus.modified ?? 0) + (gitStatus.untracked ?? 0) + (gitStatus.staged ?? 0) + (gitStatus.conflicted ?? 0)
    : 0

  // Untracked files ride along on checkout, so only tracked changes block it.
  const blockedCount = gitStatus
    ? (gitStatus.modified ?? 0) + (gitStatus.staged ?? 0) + (gitStatus.conflicted ?? 0)
    : 0

  const refreshGitRefs = useCallback(async (query: string): Promise<void> => {
    setGitLoading(true)
    setGitError(null)
    try {
      const [branchesRes, logRes] = await Promise.all([
        window.api.git.branches(),
        window.api.git.log({ limit: 100, query: query.trim() })
      ])
      if ('error' in branchesRes) {
        setGitError(branchesRes.error)
      } else {
        setGitBranches(branchesRes.branches)
      }
      if ('error' in logRes) {
        setGitError((prev) => prev ?? logRes.error)
      } else {
        setGitCommits(logRes.commits)
        setGitHead(logRes.head)
      }
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err))
    } finally {
      setGitLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!gitOpen) return
    setGitNotice(null)
    void refreshGitRefs('')
  }, [gitOpen, refreshGitRefs])

  useEffect(() => {
    if (!gitOpen) return
    const timer = setTimeout(() => {
      void refreshGitRefs(gitQuery)
    }, 250)
    return () => clearTimeout(timer)
  }, [gitQuery, gitOpen, refreshGitRefs])

  const checkoutGitRef = useCallback(async (ref: string, isCommit: boolean): Promise<void> => {
    if (blockedCount > 0) {
      setGitNotice(`Uncommitted: ${blockedCount} tracked file${blockedCount > 1 ? 's' : ''} — commit or discard changes before switching. Untracked files ride along.`)
      return
    }
    setGitBusyRef(ref)
    setGitNotice(null)
    setGitError(null)
    try {
      const res = await window.api.git.checkout(ref)
      if (res && 'error' in res) {
        setGitError(res.error)
      } else {
        await refreshGit()
        await refreshGitRefs(gitQuery)
        if (isCommit) setGitNotice(`Detached HEAD at ${(res as { hash: string }).hash}`)
      }
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err))
    } finally {
      setGitBusyRef(null)
    }
  }, [blockedCount, gitQuery, refreshGit, refreshGitRefs])

  const createGitBranch = useCallback(async (): Promise<void> => {
    const name = gitQuery.trim()
    if (!name) return
    if (blockedCount > 0) {
      setGitNotice(`Uncommitted: ${blockedCount} tracked file${blockedCount > 1 ? 's' : ''} — commit or discard changes before switching. Untracked files ride along.`)
      return
    }
    setGitBusyRef(`new:${name}`)
    setGitNotice(null)
    setGitError(null)
    try {
      const res = await window.api.git.createBranch(name)
      if (res && 'error' in res) {
        setGitError(res.error)
      } else {
        setGitQuery('')
        await refreshGit()
        await refreshGitRefs('')
      }
    } catch (err) {
      setGitError(err instanceof Error ? err.message : String(err))
    } finally {
      setGitBusyRef(null)
    }
  }, [blockedCount, gitQuery, refreshGit, refreshGitRefs])

  useEffect(() => {
    let timer: number | null = null
    const onFlash = (event: Event): void => {
      const text = (event as CustomEvent<string>).detail
      if (typeof text !== 'string' || !text.trim()) return
      setFlash(text.trim())
      if (timer !== null) window.clearTimeout(timer)
      timer = window.setTimeout(() => {
        setFlash((current) => (current === text.trim() ? null : current))
        timer = null
      }, 4000)
    }
    window.addEventListener('orcspace:title-flash', onFlash)
    return () => {
      window.removeEventListener('orcspace:title-flash', onFlash)
      if (timer !== null) window.clearTimeout(timer)
    }
  }, [])


  const isCodeView = activeView === 'code'
  const arrangeItems: ReadonlyArray<{ mode: string; label: string; hint: string }> =
    isCodeView ? CODE_ARRANGE_ITEMS : CANVAS_ARRANGE_ITEMS
  const activeArrangeMode: string = isCodeView ? codeLayoutMode : arrangeMode
  const arrangeLabel = isCodeView ? 'Arrange terminals' : 'Arrange widgets'

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  return (
    <div
      className="title-bar-shell pointer-events-auto fixed inset-x-0 top-0 z-[50000] grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] h-10 w-full min-w-full items-center pl-2 pr-0 select-none"
      style={
        {
          WebkitAppRegion: 'no-drag',



          ...(IS_MAC ? { paddingLeft: 78 } : {})
        } as React.CSSProperties
      }
    >
      {}
      <div className="flex h-10 min-w-0 items-center gap-3 overflow-hidden" style={noDrag}>
          <div className={`${VIEW_SWITCH} title-bar-history-switch`} aria-label="Canvas history">
            <button
              type="button"
              className={`${VIEW_TAB} justify-center ${canUndo ? VIEW_TAB_INACTIVE : 'cursor-default text-white/25'}`}
              onClick={onUndo}
              disabled={!canUndo}
              title="Undo"
              aria-label="Undo"
              data-testid="titlebar-undo"
            >
              <ArrowLeft size={15} />
            </button>
            <button
              type="button"
              className={`${VIEW_TAB} justify-center ${canRedo ? VIEW_TAB_INACTIVE : 'cursor-default text-white/25'}`}
              onClick={onRedo}
              disabled={!canRedo}
              title="Redo"
              aria-label="Redo"
              data-testid="titlebar-redo"
            >
              <ArrowRight size={15} />
            </button>
          </div>
        {activeView === 'code' && (
          <div
            className={`${VIEW_SWITCH} title-bar-view-switch absolute top-[5px] z-10 flex-none`}
            style={{ ...noDrag, left: codeSidebarCollapsed ? (IS_MAC ? 170 : 100) : 204 }}
          >
          <button
            type="button"
            className={`${VIEW_TAB} title-bar-view-tab ${codeSidebarCollapsed ? VIEW_TAB_INACTIVE : VIEW_TAB_ACTIVE} justify-center focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent`}
            style={noDrag}
            title={codeSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={codeSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!codeSidebarCollapsed}
            onClick={onToggleCodeSidebar}
          >
            <PanelLeft size={14} />
          </button>
          </div>
        )}
        {flash && (
          <div role="status" className={`${ISLAND} min-w-0 px-3`}>
            <span className="truncate text-[13px] font-medium text-text">{flash}</span>
          </div>
        )}
        <div
          className="h-full flex-1"
          style={{
            WebkitAppRegion: 'drag',
            marginLeft: activeView === 'code' ? (codeSidebarCollapsed ? 40 : 144) : 0
          } as React.CSSProperties}
        />
      </div>

      {}
      <div style={noDrag}>
        <div className="flex items-center gap-1" style={noDrag}>
          <div
            className={`${VIEW_SWITCH} title-bar-view-switch pointer-events-auto`}
            style={noDrag}
            role="tablist"
            aria-label="Workspace View"
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight' && e.key !== 'Home' && e.key !== 'End') return
              e.preventDefault()
              const tabs = Array.from((e.currentTarget as HTMLElement).querySelectorAll('[role="tab"]')) as HTMLElement[]
              if (tabs.length === 0) return
              const idx = tabs.indexOf(document.activeElement as HTMLElement)
              let next = 0
              if (e.key === 'ArrowRight') next = (idx + 1 + tabs.length) % tabs.length
              else if (e.key === 'ArrowLeft') next = (idx - 1 + tabs.length) % tabs.length
              else if (e.key === 'Home') next = 0
              else next = tabs.length - 1
              tabs[next]?.focus()
            }}
          >
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('canvas')}
            aria-selected={activeView === 'canvas'}
            className={`${VIEW_TAB} title-bar-view-tab ${activeView === 'canvas' ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}`}
            title="Canvas"
          >
            <span>Canvas</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('code')}
            aria-selected={activeView === 'code'}
            className={`${VIEW_TAB} title-bar-view-tab ${activeView === 'code' ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}`}
            title="Code"
          >
            <span>Code</span>
          </button>
          </div>
        </div>
      </div>

      {}
      <div className="flex h-10 min-w-0 items-center justify-end" style={noDrag}>
        <div className="h-full flex-1" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <div ref={rightIslandRef} className={`${ISLAND} relative gap-0`}>
          <div className={`${VIEW_SWITCH} mr-1`}>
            <button
              type="button"
              className={`${VIEW_TAB} gap-1.5 px-[9px] ${terminalsFlipped ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}`}
              onClick={onToggleTerminalsFlipped}
              aria-pressed={terminalsFlipped}
              data-testid="titlebar-flip-terminals"
              title={terminalsFlipped ? 'Show terminals' : 'Flip terminals to latest prompts'}
            >
              {terminalsFlipped ? <Eye size={14} /> : <EyeOff size={14} />}
              <span>{terminalsFlipped ? 'Show terminals' : 'Flip terminals'}</span>
            </button>
          </div>
          <div className="relative mr-1">
            <div className={VIEW_SWITCH}>
              <button
                type="button"
                aria-haspopup="menu"
                aria-expanded={arrangeOpen}
                aria-label={arrangeLabel}
                title={arrangeLabel}
                className={`${VIEW_TAB} gap-1.5 px-[8px] ${arrangeOpen ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}`}
                onClick={() => {
                  setGitOpen(false)
                  setArrangeOpen((open) => !open)
                }}
              >
                <LayoutGrid size={14} className="flex-none" />
              </button>
            </div>
            {arrangeOpen && (
              <div
                role="menu"
                aria-label={arrangeLabel}
                className="absolute right-0 top-[36px] z-[60000] w-[210px] rounded-panel border border-line-soft bg-bg-panel p-1 text-left shadow-2xl"
              >
                {arrangeItems.map((item) => {
                  const checked = item.mode === activeArrangeMode
                  return (
                    <button
                      key={item.mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      title={item.hint}
                      onClick={() => {
                        setArrangeOpen(false)
                        if (activeView === 'code') onCodeLayout(item.mode as CodeLayoutMode)
                        else onArrange(item.mode as ArrangeMode)
                      }}
                      className={`flex w-full items-center gap-2 rounded-panel px-2 py-1.5 text-left text-[12px] transition-colors ${checked ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{item.label}</span>
                        <span className="block truncate text-[10px] text-text-faint">{item.hint}</span>
                      </span>
                      {checked && <span className="flex-none text-[13px] text-text">✓</span>}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
          {}
          <div className={`${VIEW_SWITCH} title-bar-git-switch`}>
          <button
            type="button"
            aria-haspopup="dialog"
            aria-expanded={gitOpen}
            className={`${VIEW_TAB} title-bar-git gap-1.5 ${gitOpen ? VIEW_TAB_ACTIVE : VIEW_TAB_INACTIVE}`}
            onClick={() => {
              setArrangeOpen(false)
              setGitOpen((open) => {
                if (!open) setGitQuery('')
                return !open
              })
              void refreshGit()
            }}
            title={
              gitStatus?.repo
                ? `Git (${gitStatus.branch || 'HEAD'})\n${dirtyCount > 0 ? `${dirtyCount} changed file${dirtyCount > 1 ? 's' : ''}` : 'Working tree clean'}`
                : 'Git — not a repository'
            }
          >
            <GitBranch
              size={14}
              className={`flex-none ${gitOpen ? 'text-white' : gitStatus?.repo ? (dirtyCount > 0 ? 'text-accent' : 'text-text-dim') : 'text-text-faint'}`}
            />
            {

}
            <span className="hidden min-[1000px]:inline max-w-[110px] truncate">
              {gitStatus?.repo ? gitStatus.branch || 'HEAD' : 'Git'}
            </span>
            {dirtyCount > 0 && <span className="h-1.5 w-1.5 flex-none rounded-pill bg-accent" />}
          </button>
          </div>

          {gitOpen && (
            <div className="absolute right-2 top-[38px] z-[60000] flex max-h-[70vh] w-[340px] flex-col rounded-panel border border-line-soft bg-bg-panel text-left shadow-2xl">
              <div className="border-b border-line-soft p-3 pb-2">
                <input
                  value={gitQuery}
                  onChange={(e) => setGitQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && gitQuery.trim() && !gitBranches.some((b) => b.name === gitQuery.trim())) {
                      void createGitBranch()
                    }
                  }}
                  placeholder="Search branches and commits"
                  aria-label="Search branches and commits"
                  className="w-full rounded-panel border border-line-soft bg-bg-hover px-2 py-1.5 text-[12px] text-text placeholder:text-text-faint focus:border-accent focus:outline-none"
                />
                {gitStatus?.repo && (
                  <div className="mt-1.5 flex items-center justify-between text-[11px] text-text-dim">
                    <span className="truncate">
                      {gitStatus.branch || 'HEAD'}
                      {gitStatus.branch === 'HEAD' && gitHead && <span className="text-accent"> · detached at {gitHead.slice(0, 8)}</span>}
                    </span>
                    <span className="flex-none">{dirtyCount ? `Uncommitted: ${dirtyCount} file${dirtyCount > 1 ? 's' : ''}` : 'clean'}</span>
                  </div>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto p-3 pt-2">
                {gitNotice && (
                  <p role="status" className="mb-2 rounded-panel border border-accent/40 bg-accent/10 px-2 py-1.5 text-[11px] text-text">{gitNotice}</p>
                )}
                {gitError && (
                  <p role="alert" className="mb-2 break-words rounded-panel border border-danger/40 bg-danger/10 px-2 py-1.5 text-[11px] text-danger">{gitError}</p>
                )}
                {!gitStatus ? (
                  <p className="text-[12px] text-text-dim">Checking repository…</p>
                ) : !gitStatus.repo ? (
                  <div className="space-y-1 text-[12px]">
                    <p className="text-text-dim">This workspace is not a Git repository.</p>
                    {gitStatus.error && <p className="break-words text-accent">{gitStatus.error}</p>}
                  </div>
                ) : (
                  <div className="space-y-3 text-[12px]">
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-text-faint">Branches</div>
                      {gitLoading && gitBranches.length === 0 ? (
                        <p className="text-text-dim">Loading branches…</p>
                      ) : gitBranches.length === 0 ? (
                        <p className="text-text-dim">No branches match.</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {gitBranches.map((branch) => {
                            const busy = gitBusyRef === branch.name
                            return (
                              <li key={branch.name}>
                                <button
                                  type="button"
                                  disabled={busy || branch.current}
                                  onClick={() => void checkoutGitRef(branch.name, false)}
                                  title={blockedCount > 0 && !branch.current ? 'Commit or discard changes before switching' : `Checkout ${branch.name}`}
                                  className={`flex w-full items-center gap-2 rounded-panel px-2 py-1.5 text-left transition-colors ${branch.current ? 'bg-bg-hover text-text' : 'text-text-dim hover:bg-bg-hover hover:text-text'} disabled:cursor-default disabled:opacity-80`}
                                >
                                  <GitBranch size={13} className="flex-none text-text-faint" />
                                  <span className="min-w-0 flex-1 truncate font-medium">{branch.name}</span>
                                  {branch.current && dirtyCount > 0 && (
                                    <span className="flex-none text-[10px] text-text-dim">Uncommitted: {dirtyCount} file{dirtyCount > 1 ? 's' : ''}</span>
                                  )}
                                  {branch.current && <span className="flex-none text-[13px] text-text">✓</span>}
                                  {busy && <span className="flex-none text-[10px] text-text-dim">…</span>}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                    <div>
                      <div className="mb-1 text-[11px] font-semibold text-text-faint">History</div>
                      {gitLoading && gitCommits.length === 0 ? (
                        <p className="text-text-dim">Loading history…</p>
                      ) : gitCommits.length === 0 ? (
                        <p className="text-text-dim">No commits match.</p>
                      ) : (
                        <ul className="space-y-0.5">
                          {gitCommits.map((commit) => {
                            const isHead = Boolean(gitHead) && (gitHead.startsWith(commit.hash) || commit.hash.startsWith(gitHead))
                            const busy = gitBusyRef === commit.hash
                            return (
                              <li key={commit.hash}>
                                <button
                                  type="button"
                                  disabled={busy || isHead}
                                  onClick={() => void checkoutGitRef(commit.hash, true)}
                                  title={blockedCount > 0 && !isHead ? 'Commit or discard changes before switching' : `Checkout ${commit.short} (detached)`}
                                  className="flex w-full items-center gap-2 rounded-panel px-2 py-1.5 text-left text-text-dim transition-colors hover:bg-bg-hover hover:text-text disabled:cursor-default disabled:opacity-80"
                                >
                                  <span className="flex-none font-mono text-[10px] text-accent">{commit.short}</span>
                                  <span className="min-w-0 flex-1 truncate" title={commit.subject}>{commit.subject}</span>
                                  {isHead && <span className="flex-none text-[13px] text-text">✓</span>}
                                  {busy && <span className="flex-none text-[10px] text-text-dim">…</span>}
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                  </div>
                )}
              </div>
              {gitStatus?.repo && (
                <div className="border-t border-line-soft p-2">
                  <button
                    type="button"
                    disabled={!gitQuery.trim() || gitBranches.some((b) => b.name === gitQuery.trim()) || gitBusyRef === `new:${gitQuery.trim()}`}
                    onClick={() => void createGitBranch()}
                    className="flex w-full items-center gap-2 rounded-panel px-2 py-1.5 text-left text-[12px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <span className="flex-none text-[14px]">+</span>
                    <span className="truncate">
                      {gitQuery.trim() ? `Create and checkout new branch “${gitQuery.trim()}”…` : 'Create and checkout new branch…'}
                    </span>
                  </button>
                </div>
              )}
            </div>
          )}

          {!IS_MAC && (
            <>
              <span className="mx-0.5 h-4 w-px flex-none bg-line-soft/80" />

              <button
                className={`${ICON} ${QUIET}`}
                title="Minimize"
                aria-label="Minimize"
                onClick={() => void Promise.resolve(window.api.window.minimize()).catch(() => {})}
              >
                <Minus size={14} strokeWidth={2.2} />
              </button>
              {/*
                QUIET whether or not the window is maximized, unlike the panel
                toggles above. ON is the hover fill, so wearing it at rest made
                this button look stuck under the cursor next to a plain
                minimise and close — which is what it is, a window control, not
                a toggle you read the state of. That state is already carried
                three times over: the icon swaps, the label swaps, and
                aria-pressed says it outright.
              */}
              <button
                className={`${ICON} ${QUIET}`}
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                aria-pressed={maximized}
                onClick={() => void Promise.resolve(window.api.window.toggleMaximize()).catch(() => {})}
              >
                {maximized ? <Copy size={13} strokeWidth={2} /> : <Square size={13} strokeWidth={2} />}
              </button>
              <button
                className={`${ICON} text-text-dim hover:bg-[#e04343] hover:text-white`}
                title="Close"
                aria-label="Close"
                onClick={() => void Promise.resolve(window.api.window.close()).catch(() => {})}
              >
                <X size={14} strokeWidth={2.2} />
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  )
})
