import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Copy, GitBranch, Minus, Square, X } from 'lucide-react'
import type { GitStatus } from '../../../preload/index.d'
import { IS_MAC } from '../lib/platform'

export type WorkView = 'canvas' | 'browser' | 'code'

/**
 * One geometry for the whole bar, declared once so the three islands cannot
 * drift apart: every island is the same height, radius, border and inner
 * padding, and every control inside them is the same 22px tall with the same
 * 6px radius. Changing the bar's scale is a change to these five lines.
 */
const ISLAND =
  'flex h-[34px] items-center gap-[3px] rounded-full border border-[#2a2a2e] bg-[#1c1c1f] p-[3px]'
/** A labelled capsule: icon + text. The border is always there, transparent
 *  when the control is idle, so turning it on cannot nudge the row by a pixel. */
const PILL =
  'flex h-[28px] flex-none items-center gap-1.5 rounded-full border border-transparent px-3 text-[13px] font-medium transition-colors duration-150 cursor-pointer select-none outline-none'
/** An icon-only capsule — the window buttons. */
const ICON =
  'grid h-[28px] w-[32px] flex-none place-items-center rounded-full border border-transparent transition-colors duration-150 cursor-pointer outline-none'
const QUIET = 'text-[#8a8a90] hover:bg-[#232326] hover:text-[#ececec]'
const ON = 'bg-[#2a2a2e] text-[#ececec] border-transparent'

interface Props {
  /** Owned by App: the switcher only reports intent, the surfaces live there. */
  activeView: WorkView
  onViewChange: (view: WorkView) => void
}

// Memoized: App re-renders on every camera frame; the bar's own state (git
// poll, flash, maximized) is what should drive its renders, not the canvas
// moving underneath it. `onViewChange` is a stable useCallback in App.
export default React.memo(function TitleBar({ activeView, onViewChange }: Props): React.JSX.Element {
  const [maximized, setMaximized] = useState(false)
  const [flash, setFlash] = useState<string | null>(null)
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null)
  const [gitOpen, setGitOpen] = useState(false)
  const gitIslandRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!gitOpen) return
    const onDown = (e: MouseEvent): void => {
      if (gitIslandRef.current && !gitIslandRef.current.contains(e.target as Node)) setGitOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setGitOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [gitOpen])

  useEffect(() => {
    // On failure the default (restored window) is the safe assumption.
    void window.api.window.isMaximized().then(setMaximized).catch(() => setMaximized(false))
    return window.api.window.onMaximizeChange(setMaximized)
  }, [])

  const gitSeq = useRef(0)
  const refreshGit = useCallback(async (): Promise<void> => {
    const seq = ++gitSeq.current
    try {
      const res = (await window.api.git.status()) as GitStatus | { error: string }
      if (seq !== gitSeq.current) return
      if (res && !('error' in res)) {
        setGitStatus(res as GitStatus)
      } else {
        setGitStatus(null)
      }
    } catch {
      if (seq !== gitSeq.current) return
      setGitStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshGit()
    // Self-scheduling chain instead of a fixed interval: while the window is
    // focused the tree refreshes every 8s, but unfocused/backgrounded it backs
    // off to 30s — git status is not going anywhere, and a background OrcSpace
    // should not wake the CPU (and spawn a git process) three times a minute
    // for a badge nobody is looking at (PERF-git-backoff).
    let timer: ReturnType<typeof setTimeout>
    const schedule = (): void => {
      const delay = document.hidden || !document.hasFocus() ? 30_000 : 8_000
      timer = setTimeout(() => {
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
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onFocus)
      offDir()
    }
  }, [refreshGit])

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

  const dirtyCount = gitStatus
    ? gitStatus.modified + gitStatus.untracked + gitStatus.staged + gitStatus.conflicted
    : 0

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  // No `onDoubleClick` here on purpose. The bar is a `-webkit-app-region:
  // drag` caption area, and both platforms already give a caption
  // double-click the native maximize/restore (macOS honours the system
  // "double-click a window's title bar to" preference, Windows treats the
  // region as HTCAPTION). Adding a JS `toggleMaximize()` on top of that fires
  // *after* the native toggle and immediately undoes it.

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-0 z-[50000] flex h-10 items-center px-2 bg-transparent select-none"
      style={
        {
          WebkitAppRegion: 'drag',
          // macOS draws its traffic lights inside this bar (the window is
          // frameless but keeps them). Reserve the gutter they sit in so the
          // left island never lands underneath close/minimise/zoom.
          ...(IS_MAC ? { paddingLeft: 78 } : {})
        } as React.CSSProperties
      }
    >
      {/* Left island: transient status messages only. */}
      <div className="flex h-10 min-w-0 max-w-[340px] flex-none items-center gap-1.5" style={noDrag}>
        {flash && (
          <div role="status" className={`${ISLAND} min-w-0 px-3`}>
            <span className="truncate text-[13px] font-medium text-text">{flash}</span>
          </div>
        )}
      </div>

      {/* Centre island: Canvas / Browser / Code switch the visible surface. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
        <div className={`${ISLAND} pointer-events-auto`} style={noDrag} role="tablist" aria-label="Workspace View">
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('canvas')}
            aria-selected={activeView === 'canvas'}
            className={`${PILL} ${activeView === 'canvas' ? ON : QUIET}`}
            title="Canvas"
          >
            <span>Canvas</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('browser')}
            aria-selected={activeView === 'browser'}
            className={`${PILL} ${activeView === 'browser' ? ON : QUIET}`}
            title="Browser"
          >
            <span>Browser</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={() => onViewChange('code')}
            aria-selected={activeView === 'code'}
            className={`${PILL} ${activeView === 'code' ? ON : QUIET}`}
            title="Code"
          >
            <span>Code</span>
          </button>
        </div>
      </div>

      <div className="flex-1" />

      {/* Right island: Git, then the window itself. */}
      <div className="flex h-10 flex-none items-center" style={noDrag}>
        <div ref={gitIslandRef} className={`${ISLAND} relative`}>
          <button
            type="button"
            className={`${PILL} ${QUIET}`}
            onClick={() => {
              setGitOpen((open) => !open)
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
              className={`flex-none ${gitStatus?.repo ? (dirtyCount > 0 ? 'text-accent' : 'text-text-dim') : 'text-text-faint'}`}
            />
            {/* The branch name is the widest thing on the bar; past this width the
                right island would run into the centred view switcher (the OS-level
                minWidth is 800). The icon + dirty dot still carry the state. */}
            <span className="hidden min-[1000px]:inline max-w-[110px] truncate">
              {gitStatus?.repo ? gitStatus.branch || 'HEAD' : 'Git'}
            </span>
            {dirtyCount > 0 && <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" />}
          </button>

          {gitOpen && (
            <div className="absolute right-2 top-[38px] z-[60000] w-[310px] rounded-[12px] border border-line-soft bg-bg-panel/95 p-3 text-left shadow-2xl glass:backdrop-blur-xl">
              <div className="mb-2 flex items-center justify-between gap-3">
                <span className="text-[12px] font-semibold text-text">Git status</span>
                <button
                  type="button"
                  className="rounded-md px-1.5 py-0.5 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text"
                  onClick={() => void refreshGit()}
                >
                  Refresh
                </button>
              </div>
              {!gitStatus ? (
                <p className="text-[12px] text-text-dim">Checking repository…</p>
              ) : !gitStatus.repo ? (
                <div className="space-y-1 text-[12px]">
                  <p className="text-text-dim">This workspace is not a Git repository.</p>
                  {gitStatus.error && <p className="break-words text-accent">{gitStatus.error}</p>}
                </div>
              ) : (
                <div className="space-y-2 text-[12px]">
                  <div className="flex items-center justify-between gap-3">
                    <span className="truncate font-medium text-text">{gitStatus.branch || 'HEAD'}</span>
                    <span className="flex-none text-text-dim">{dirtyCount ? `${dirtyCount} changed` : 'clean'}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-text-dim">
                    <span>Modified: {gitStatus.modified}</span>
                    <span>Untracked: {gitStatus.untracked}</span>
                    <span>Staged: {gitStatus.staged}</span>
                    <span>Conflicts: {gitStatus.conflicted}</span>
                    <span>Ahead: {gitStatus.ahead}</span>
                    <span>Behind: {gitStatus.behind}</span>
                  </div>
                  {gitStatus.lastCommit && (
                    <div className="border-t border-line-soft pt-2">
                      <div className="text-[11px] text-text-faint">Last commit · {gitStatus.lastCommit.hash}</div>
                      <div className="truncate text-text" title={gitStatus.lastCommit.subject}>{gitStatus.lastCommit.subject}</div>
                    </div>
                  )}
                  <div className="truncate border-t border-line-soft pt-2 text-[10px] text-text-faint" title={gitStatus.root}>
                    {gitStatus.root}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* macOS renders its own traffic lights at the far left of this bar,
              so a second set of window buttons on the right is both redundant
              and non-native. Windows and Linux keep them — the frame is off and
              they are the only way to minimise, maximise or close. */}
          {!IS_MAC && (
            <>
              <span className="mx-0.5 h-4 w-px flex-none bg-line-soft/80" />

              <button
                className={`${ICON} ${QUIET}`}
                title="Minimize"
                aria-label="Minimize"
                onClick={() => window.api.window.minimize()}
              >
                <Minus size={14} strokeWidth={2.2} />
              </button>
              <button
                className={`${ICON} ${QUIET}`}
                title={maximized ? 'Restore' : 'Maximize'}
                aria-label={maximized ? 'Restore' : 'Maximize'}
                onClick={() => window.api.window.toggleMaximize()}
              >
                {maximized ? <Copy size={13} strokeWidth={2} /> : <Square size={13} strokeWidth={2} />}
              </button>
              <button
                className={`${ICON} text-text-dim hover:bg-[#e04343] hover:text-white`}
                title="Close"
                aria-label="Close"
                onClick={() => window.api.window.close()}
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
