import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Brain, Copy, GitBranch, Globe, LayoutGrid, Minus, Square, TerminalSquare, X } from 'lucide-react'
import type { GitStatus } from '../../../preload/index.d'

export type WorkView = 'canvas' | 'browser' | 'code'

/**
 * One geometry for the whole bar, declared once so the three islands cannot
 * drift apart: every island is the same height, radius, border and inner
 * padding, and every control inside them is the same 22px tall with the same
 * 6px radius. Changing the bar's scale is a change to these five lines.
 */
const ISLAND =
  'flex h-[34px] items-center gap-[3px] rounded-full border border-line-soft bg-bg-panel/85 p-[3px] shadow-sm glass:bg-bg-panel/75 glass:backdrop-blur-xl'
/** A labelled capsule: icon + text. The border is always there, transparent
 *  when the control is idle, so turning it on cannot nudge the row by a pixel. */
const PILL =
  'flex h-[28px] flex-none items-center gap-1.5 rounded-full border border-transparent px-3 text-[13px] font-medium transition-colors duration-150 cursor-pointer select-none outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60'
/** An icon-only capsule — the window buttons. */
const ICON =
  'grid h-[28px] w-[32px] flex-none place-items-center rounded-full border border-transparent transition-colors duration-150 cursor-pointer outline-none focus-visible:ring-1 focus-visible:ring-text-faint/60'
const QUIET = 'text-text-dim hover:bg-bg-hover hover:text-text'
const ON = 'border-line-soft bg-bg-hover text-text shadow-xs'

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
  const [memoryOpen, setMemoryOpen] = useState(false)

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

  // Memory (Second Brain) is a panel inside the canvas, not a surface this
  // bar owns — so it's opened by asking the canvas, and its state is learned
  // back the same way, matching the flash-message bus above.
  useEffect(() => {
    const onBrainOpenChange = (event: Event): void => {
      setMemoryOpen(Boolean((event as CustomEvent<boolean>).detail))
    }
    window.addEventListener('orcspace:brain-open-change', onBrainOpenChange)
    return () => window.removeEventListener('orcspace:brain-open-change', onBrainOpenChange)
  }, [])

  const toggleMemory = (): void => {
    onViewChange('canvas')
    window.dispatchEvent(new CustomEvent('orcspace:toggle-brain'))
  }

  const dirtyCount = gitStatus
    ? gitStatus.modified + gitStatus.untracked + gitStatus.staged + gitStatus.conflicted
    : 0

  const noDrag = { WebkitAppRegion: 'no-drag' } as React.CSSProperties

  return (
    <div
      className="pointer-events-auto absolute inset-x-0 top-0 z-[50000] flex h-10 items-center px-2 bg-transparent select-none"
      style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
    >
      {/* Left island: transient status messages only. */}
      <div className="flex h-10 min-w-0 max-w-[340px] flex-none items-center gap-1.5" style={noDrag}>
        {flash && (
          <div role="status" className={`${ISLAND} min-w-0 px-3`}>
            <span className="truncate text-[13px] font-medium text-text">{flash}</span>
          </div>
        )}
      </div>

      {/* Centre island: Canvas / Browser switch the visible surface;
          Memory toggles the Second Brain panel over whichever surface is showing. */}
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
            <LayoutGrid size={14} className="flex-none" />
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
            <Globe size={14} className="flex-none" />
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
            <TerminalSquare size={14} className="flex-none" />
            <span>Code</span>
          </button>
          <button
            type="button"
            role="tab"
            onClick={toggleMemory}
            aria-selected={memoryOpen}
            className={`${PILL} ${memoryOpen ? ON : QUIET}`}
            title="Memory"
          >
            <Brain size={14} className="flex-none" />
            <span>Memory</span>
          </button>
        </div>
      </div>

      <div className="flex-1" />

      {/* Right island: Git, then the window itself. */}
      <div className="flex h-10 flex-none items-center" style={noDrag}>
        <div className={ISLAND}>
          <button
            type="button"
            className={`${PILL} ${QUIET}`}
            onClick={() => void refreshGit()}
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
        </div>
      </div>
    </div>
  )
})
