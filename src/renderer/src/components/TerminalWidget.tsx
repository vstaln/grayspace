import React, { useCallback, useEffect, useRef, useState } from 'react'
import { AlertTriangle, MessageSquareText, Terminal as TerminalIcon, X } from 'lucide-react'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { attachmentAgent, imagePasteShortcut, insertAttachments, isTerminalPasteShortcut } from '../lib/terminalAttachments'
import { clearInitialCommand, deliverInitialCommand, initialCommandWaitMs, markInitialCommandDelivered, peekInitialCommand } from '../lib/pendingTerminalCommands'
import { initialCommandVerdict } from '../lib/initialCommandGate'
import { IS_MAC } from '../lib/platform'
import { TerminalRenderQueue } from '../lib/terminalRenderQueue'
import { APP_OWNED_MODE_RESET, terminalRestoreData } from '../lib/terminalRestore'
import { isPointerScaled, pointerScale, unscalePointer } from '../lib/terminalPointerScale'
import { palette } from '../ui/tokens'
import { captureTerminalInput, EMPTY_TERMINAL_PROMPT_CAPTURE } from '../lib/terminalPromptCapture'
import { shouldReassertCursorBlink } from '../lib/terminalCursorBlink'
import {
  createStartupProbe,
  EXIT_CONFIRM_MS,
  readStartupOutput,
  STARTUP_WATCH_MS,
  type StartupProbe
} from '../lib/terminalStartupFailure'
import {
  createModeRecoveryProbe,
  hasOrphanedModes,
  readChildTitle,
  readEchoedMouseReports
} from '../lib/terminalModeRecovery'


const cachedSubmit = '\r'

/** Keep xterm and the PTY at one geometry while a widget is being resized. */
const RESIZE_SETTLE_DELAY_MS = 150





const terminalViewportById = new Map<string, { line: number; atBottom: boolean }>()
const MAX_VIEWPORT_ENTRIES = 300
function rememberViewport(id: string, entry: { line: number; atBottom: boolean }): void {
  terminalViewportById.set(id, entry)
  if (terminalViewportById.size > MAX_VIEWPORT_ENTRIES) {
    const oldest = terminalViewportById.keys().next().value as string | undefined
    if (oldest) terminalViewportById.delete(oldest)
  }
}
export function forgetTerminalViewport(id: string): void {
  terminalViewportById.delete(id)
}

interface Props {
  id: string
  surface?: 'canvas' | 'code'
  title?: string
  agentId?: string
  /**
   * Accepted and persisted per widget, but nothing in here reads it yet — the
   * paste/drop attachment paths below run the same way whatever it is set to.
   * Left in place because the plumbing (and its localStorage entry) belongs to
   * a feature that is still being built, not to dead code.
   */
  attachmentMode?: boolean
  flipped?: boolean
  onProcessExit?: () => void
}

type StartupNotice = { message: string; tone: 'error' | 'info' }


const BASE_COLORS = {
  foreground: '#e8e8ea',
  cursor: '#e8e8ea',
  selectionBackground: 'rgba(120, 160, 255, 0.35)',
  black: '#050506',
  red: '#f07178',
  green: '#7fd99a',
  yellow: '#e6c07b',
  blue: '#7aa2f7',
  magenta: '#c792ea',
  cyan: '#7dcfff',
  white: '#d4d4d8',
  brightBlack: '#6b6b74',
  brightRed: '#ff8b92',
  brightGreen: '#95e6a8',
  brightYellow: '#f0d48a',
  brightBlue: '#9ab8ff',
  brightMagenta: '#d7a6f5',
  brightCyan: '#9de8ff',
  brightWhite: '#ffffff'
}






function xtermTheme(_appTheme: ThemeName, surface: 'canvas' | 'code'): ITheme {
  const isCanvas = surface === 'canvas'
  return {
    ...BASE_COLORS,
    // xterm's color parser rejects the CSS keyword `transparent` and falls
    // back to opaque black. Use an 8-digit hex color so the viewport and DOM
    // renderer keep a transparent background on canvas terminals.
    background: isCanvas ? '#08080800' : (surface === 'code' ? '#080808' : palette.terminalSolid),
    cursorAccent: palette.wallpaperBase
  }
}

function TerminalWidget({ id, surface = 'canvas', title, agentId, flipped = false, onProcessExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const flippedRef = useRef(flipped)
  flippedRef.current = flipped
  const titleRef = useRef(title)
  titleRef.current = title
  const agentIdRef = useRef(attachmentAgent(agentId ?? ''))
  // An explicit launcher selection is authoritative. Without this guard a
  // prompt such as "explain codex" typed into Claude could be mistaken for a
  // shell command and change the attachment shortcut mid-session.
  const agentIdentityLockedRef = useRef(Boolean(agentId?.trim()))
  useEffect(() => {
    agentIdRef.current = attachmentAgent(agentId ?? '')
    agentIdentityLockedRef.current = Boolean(agentId?.trim())
  }, [agentId])


  const [connecting, setConnecting] = useState(true)
  /**
   * An agent that died during startup rather than a terminal that is broken.
   * It is state, not a line written into the terminal, because the failing
   * agent has usually cleared the screen on its way out — anything written
   * there goes with it, which is how this looked like a black card.
   */
  const [startupNotice, setStartupNotice] = useState<StartupNotice | null>(null)
  const [lastPrompt, setLastPrompt] = useState('')
  const { theme } = useTheme()

  const rememberPrompt = useCallback((value: string): void => {
    const next = value.replace(/\s+/g, ' ').trim().slice(0, 12_000)
    if (!next) return
    setLastPrompt(next)
    void window.api.terminal.setLastPrompt(id, next).catch(() => {})
  }, [id])

  useEffect(() => {
    let mounted = true
    void window.api.terminal.list().then((items) => {
      const prompt = items.find((item) => item.id === id)?.lastPrompt
      if (mounted && prompt) setLastPrompt(prompt)
    }).catch(() => {})
    const off = window.api.terminal.onPrompt(id, (prompt) => setLastPrompt(prompt))
    return () => {
      mounted = false
      off()
    }
  }, [id])

  useEffect(() => {
    if (!flipped) {
      // Coming back from the prompt card: hand typing focus back to the shell
      // so the cursor blinks right away instead of staying an outline.
      termRef.current?.focus()
      return
    }
    const container = containerRef.current
    const focused = document.activeElement
    if (container && focused instanceof HTMLElement && container.contains(focused)) focused.blur()
    window.api.terminal.setFocused(false, id)
  }, [flipped, id])

  const onProcessExitRef = useRef(onProcessExit)
  onProcessExitRef.current = onProcessExit


  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, surface)
  }, [theme, surface])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: xtermTheme(theme, surface),
      allowTransparency: surface === 'canvas',
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      lineHeight: 1,
      // Deliberately short, and a user-visible reduction from 5000.
      //
      // Every open terminal holds its own buffer in the renderer, and a canvas
      // full of agent sessions is the case this app is built for: at 5000 lines
      // the buffers alone were a large multiple of what the agents themselves
      // could then not allocate. Persisted scrollback is unaffected — snapshots
      // keep their own 64KB tail on disk and restore it on mount.
      scrollback: 1500,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
      // PTY echo is delivered through the renderer's output queue rather than
      // xterm's own input path. Keep typed input following the live prompt even
      // when the user was reading older scrollback before an interrupt.
      scrollOnUserInput: true,
      convertEol: false,



      allowProposedApi: true
    })
    termRef.current = term
    let mounted = true

    // No renderer addon: these run on xterm's DOM renderer deliberately.
    //
    // The WebGL addon is the usual answer to slow terminals and it was in
    // package.json for a long time, never imported. Switching it on here is
    // not the free win it looks like, because it takes one GL context *per
    // terminal* and a browser process keeps only a limited number alive —
    // around sixteen in Chromium — evicting the oldest when that is passed.
    // This app's whole premise is a canvas holding many terminals at once, so
    // the eviction is not an edge case, it is the normal state: the terminals
    // you scrolled away from quietly stop painting.
    //
    // If it is revisited, it has to be selective — the focused terminal, or a
    // capped pool — with an onContextLoss handler that falls back to the DOM
    // renderer, and it has to be measured against a baseline first. The
    // dependency is gone until then rather than sitting there implying it is
    // in use.
    const fit = new FitAddon()
    term.loadAddon(fit)


    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
    const renderQueue = new TerminalRenderQueue((data, done) => term.write(data, done), () => scheduleFlush())
    const flushChannel = new MessageChannel()
    let flushScheduled = false
    // While a scrollback restore is streaming slice-by-slice, live output
    // stays queued so it can never be interleaved into the middle of the
    // history being replayed.
    let restoreInFlight = false
    let interruptRecoveryPending = false
    let cancelRestore: (() => void) | undefined
    const flushWrites = (): void => {
      flushScheduled = false
      if (!mounted) {
        renderQueue.dispose()
        return
      }
      if (restoreInFlight) return
      renderQueue.flush()
    }
    const scheduleFlush = (): void => {
      if (!mounted || flushScheduled) return
      flushScheduled = true
      // Parsing is not painting: xterm already paints on animation frames.
      // An event task keeps echo prompt and also runs in hidden workspaces.
      flushChannel.port2.postMessage(null)
    }
    flushChannel.port1.onmessage = flushWrites
    const batchedWrite = (data: string, onParsed?: () => void): void => {
      renderQueue.push(data, onParsed)
    }
    // Ordered, backpressured writes for large restores: each slice is handed
    // to xterm only after the previous one was parsed, so the UI thread is
    // never blocked by a single huge write and ordering with later writes
    // (markers, live output) is preserved.
    const RESTORE_CHUNK_SIZE = 32768
    // Completion comes from the parser callback, never from an elapsed delay.
    // A superseded chain cannot complete a newer restore.
    let restoreGeneration = 0
    const endRestore = (generation: number): void => {
      if (generation !== restoreGeneration) return
      restoreGeneration += 1
      restoreInFlight = false
      if (!mounted) return
      renderQueue.pause(false)
      term.options.disableStdin = false
      setConnecting(false)
      scheduleFlush()
    }
    const writePaced = (text: string, done?: () => void): void => {
      cancelRestore?.()
      const generation = ++restoreGeneration
      restoreInFlight = true
      // A reflow scheduled before the restore can capture the empty buffer's
      // top line and apply it after history has arrived, pulling the viewport
      // away from the bottom. Invalidate that anchor for this restore.
      resizeAnchor = null
      resizeAnchorGeneration += 1
      renderQueue.pause(true)
      term.options.disableStdin = true
      let offset = 0
      cancelRestore = () => endRestore(generation)
      const writeNext = (): void => {
        if (generation !== restoreGeneration || !mounted) {
          endRestore(generation)
          return
        }
        if (offset >= text.length) {
          endRestore(generation)
          done?.()
          return
        }
        const end = Math.min(offset + RESTORE_CHUNK_SIZE, text.length)
        const chunk = text.slice(offset, end)
        offset = end
        try {
          term.write(chunk, writeNext)
        } catch (error) {
          console.error('terminal history restore failed', error)
          endRestore(generation)
        }
      }

      writeNext()
    }
    const restoreViewport = (saved?: { line: number; atBottom: boolean }): void => {
      // Never yank the viewport of a fullscreen TUI (alternate screen): it
      // has no scrollback and forced scrolls tear the live frame.
      if (term.buffer.active.type === 'alternate') return
      if (interruptRecoveryPending) {
        term.scrollToBottom()
        return
      }
      const viewport = saved ?? terminalViewportById.get(id)
      if (!viewport) return
      if (viewport.atBottom) term.scrollToBottom()
      else term.scrollToLine(Math.min(viewport.line, term.buffer.active.baseY))
    }




    const restoreViewportAfterLayout = (): void => {
      if (!mounted) return
      restoreViewport()
      // One frame is enough: the write that preceded this has been parsed, so
      // the second pass runs against the final buffer geometry. The third
      // nested frame only ever repeated the same scroll.
      requestAnimationFrame(() => {
        if (mounted) restoreViewport()
      })
    }
    type ViewportAnchor = { line: number; atBottom: boolean; bufferType: 'normal' | 'alternate' }
    const captureViewportAnchor = (): ViewportAnchor => {
      const activeBuffer = term.buffer.active
      return {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY,
        bufferType: activeBuffer.type === 'alternate' ? 'alternate' : 'normal'
      }
    }
    const applyViewportAnchor = (anchor: ViewportAnchor): void => {
      if (!mounted) return
      if (interruptRecoveryPending) return
      // Fullscreen TUIs live on the alternate screen buffer — forcing scroll
      // positions there corrupts the rendered frame. Anchors are also never
      // replayed across buffers: an offset captured inside Codex (typically
      // line 0, not at bottom) applied to the normal buffer after its exit
      // yanks the viewport to the very top — the "I type at the top" state.
      const currentType = term.buffer.active.type === 'alternate' ? 'alternate' : 'normal'
      if (currentType === 'alternate') return
      if (anchor.bufferType !== currentType) return
      if (anchor.atBottom) term.scrollToBottom()
      else term.scrollToLine(Math.min(anchor.line, term.buffer.active.baseY))
    }






    let resizeAnchor: ViewportAnchor | null = null
    let resizeAnchorGeneration = 0
    let resizeRestoreUntil = 0
    let fitTimer: ReturnType<typeof setTimeout> | null = null
    const markInterruptRecoveryPending = (): void => {
      interruptRecoveryPending = true
      // A resize callback captured while the TUI owned the alternate buffer
      // must not be replayed after Ctrl+C returns to the shell. Remember the
      // live bottom immediately; waiting 400ms leaves a visible race where the
      // next prompt can be rendered above the old viewport.
      resizeAnchor = null
      resizeAnchorGeneration += 1
      resizeRestoreUntil = 0
      if (term.buffer.active.type !== 'alternate') {
        try { term.scrollToBottom() } catch {}
      }
      rememberViewport(id, { line: 0, atBottom: true })
    }
    const settleInterruptRecovery = (): void => {
      if (!mounted || term.buffer.active.type === 'alternate') return
      try { term.scrollToBottom() } catch {}
      const activeBuffer = term.buffer.active
      rememberViewport(id, { line: activeBuffer.viewportY, atBottom: true })
      interruptRecoveryPending = false
    }
    const restoreResizeAnchor = (generation: number): void => {
      if (restoreInFlight || interruptRecoveryPending || generation !== resizeAnchorGeneration || !resizeAnchor) return
      applyViewportAnchor(resizeAnchor)
    }
    const scheduleResizeAnchorRestore = (anchor: ViewportAnchor): void => {
      if (restoreInFlight || interruptRecoveryPending) return
      resizeAnchor = anchor
      resizeAnchorGeneration++
      const generation = resizeAnchorGeneration
      resizeRestoreUntil = performance.now() + 300
      // One authoritative restore now, one after xterm reflows: a blind timer
      // on top only re-yanked the viewport while ConPTY's repaint was still
      // being parsed. Late reflows are covered exactly by the onWriteParsed
      // hook below instead.
      applyViewportAnchor(anchor)
      requestAnimationFrame(() => restoreResizeAnchor(generation))
    }
    // Wait until the resize settles before changing either side of the PTY.
    // Resizing xterm immediately while its process still paints at the old
    // geometry lets stale rows and columns show as stray text during a drag.
    const fitPreservingViewport = (): void => {
      if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
      if (fitTimer !== null) clearTimeout(fitTimer)
      fitTimer = setTimeout(() => {
        fitTimer = null
        if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
        fit.fit()
        // A process exit can resize the PTY while its final escape sequences
        // are still being parsed. Never capture or replay that transient
        // viewport: it belongs to the dead foreground program and would pull
        // the next shell prompt back to the old top position.
        if (interruptRecoveryPending) {
          resizeAnchor = null
          resizeAnchorGeneration += 1
          try { term.scrollToBottom() } catch {}
          const activeBuffer = term.buffer.active
          rememberViewport(id, { line: activeBuffer.viewportY, atBottom: true })
          return
        }
        const anchor = captureViewportAnchor()
        scheduleResizeAnchorRestore(anchor)
      }, RESIZE_SETTLE_DELAY_MS)
    }
    // An agent that turned DEC private mode 12 off and exited leaves the shell
    // prompt with a caret that never blinks again; an agent still painting its
    // own screen is entitled to a steady one. See shouldReassertCursorBlink.
    // Checked after parsing, before xterm paints the frame.
    const keepCursorBlinking = (): void => {
      const reassert = shouldReassertCursorBlink({
        bufferType: term.buffer.active.type === 'alternate' ? 'alternate' : 'normal',
        cursorBlink: term.options.cursorBlink === true
      })
      if (reassert) term.options.cursorBlink = true
    }
    const writeParsedDisposable = term.onWriteParsed(() => {
      keepCursorBlinking()
      if (interruptRecoveryPending) {
        if (term.buffer.active.type !== 'alternate') {
          try { term.scrollToBottom() } catch {}
          const activeBuffer = term.buffer.active
          rememberViewport(id, { line: activeBuffer.viewportY, atBottom: true })
        }
        return
      }
      if (!resizeAnchor || performance.now() > resizeRestoreUntil) return
      const generation = resizeAnchorGeneration
      requestAnimationFrame(() => restoreResizeAnchor(generation))
    })
    const scrollDisposable = term.onScroll(() => {
      // Streaming scrollback changes viewportY while baseY is still growing.
      // Those intermediate positions are not user intent and must not replace
      // the saved bottom-follow state used after restore.
      if (restoreInFlight) return
      // Alternate-buffer offsets (a TUI's internal scroll) are meaningless on
      // the normal buffer — saving them is what pinned the viewport to the top
      // after the TUI exited.
      if (term.buffer.active.type === 'alternate') return
      if (interruptRecoveryPending) {
        rememberViewport(id, { line: 0, atBottom: true })
        return
      }
      const activeBuffer = term.buffer.active
      rememberViewport(id, {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY
      })
    })

    // Launch-failure watch. Armed the moment the agent command is typed and
    // disarmed by the first verdict or by the window closing, so ordinary
    // agent output — which can quote any of these phrases — is never read as
    // a failure.
    let startupWatchUntil = 0
    let startupProbe: StartupProbe | null = null
    let startupExitTimer: ReturnType<typeof setTimeout> | null = null
    let queuedLaunchTimer: ReturnType<typeof setTimeout> | null = null
    const clearStartupExitTimer = (): void => {
      if (startupExitTimer === null) return
      clearTimeout(startupExitTimer)
      startupExitTimer = null
    }
    const watchStartupOutput = (chunk: string): void => {
      if (!startupProbe) return
      if (Date.now() > startupWatchUntil) {
        startupProbe = null
        clearStartupExitTimer()
        return
      }
      const verdict = readStartupOutput(startupProbe, chunk)
      if (!verdict) return
      if (verdict.status === 'running') {
        // A launcher shim restored the console title on its way to starting
        // the agent; the shell is not idle, so nothing is wrong after all.
        clearStartupExitTimer()
        return
      }
      if (verdict.status === 'failed') {
        startupProbe = null
        clearStartupExitTimer()
        if (mounted) setStartupNotice({ message: verdict.message, tone: 'error' })
        return
      }
      // Only a bare title that nothing supersedes is an exit, so the report
      // waits for the shim's next title instead of racing it.
      clearStartupExitTimer()
      startupExitTimer = setTimeout(() => {
        startupExitTimer = null
        startupProbe = null
        if (mounted) setStartupNotice({ message: verdict.message, tone: 'info' })
      }, EXIT_CONFIRM_MS)
    }

    /**
     * Takes the emulator back out of modes whose owner is gone.
     *
     * An agent that crashes never restores what it turned on, so the shell it
     * drops back to inherits mouse reporting it never asked for: every pointer
     * movement over the widget is then typed into the prompt as an SGR report
     * and echoed straight back, hundreds of lines of `^[[<35;36;37M` for one
     * pass of the mouse. Until now the only way out was the context menu's
     * "Reset terminal", which nobody finds while the card is filling with
     * noise.
     *
     * Two signals, because neither covers every shell. The console title says
     * the shell is idle again (cmd.exe, and PowerShell by its product name);
     * the echo itself says so regardless of what any shell reports. Both are
     * confirmed against the emulator's own state before anything is written,
     * so a full-screen application that is still running — on the alternate
     * buffer, legitimately tracking the mouse — is never interrupted.
     */
    const modeRecovery = createModeRecoveryProbe()
    let modeRecoveryTimer: ReturnType<typeof setTimeout> | null = null
    const clearModeRecoveryTimer = (): void => {
      if (modeRecoveryTimer === null) return
      clearTimeout(modeRecoveryTimer)
      modeRecoveryTimer = null
    }
    // Queued through the render queue, never written straight to the terminal:
    // output reaches the parser through that queue, and a direct write would
    // overtake everything still waiting in it.
    const readEmulatorModes = (): {
      bufferType: 'normal' | 'alternate'
      mouseTracking: string
      originMode: boolean
      synchronizedOutputMode: boolean
      insertMode: boolean
      wraparoundMode: boolean
    } => ({
      bufferType: term.buffer.active.type === 'alternate' ? 'alternate' : 'normal',
      mouseTracking: term.modes.mouseTrackingMode,
      originMode: term.modes.originMode === true,
      synchronizedOutputMode: (term.modes as { synchronizedOutputMode?: boolean }).synchronizedOutputMode === true,
      insertMode: term.modes.insertMode === true,
      wraparoundMode: term.modes.wraparoundMode !== false
    })
    const scrollPromptToBottom = (): void => {
      if (!mounted || term.buffer.active.type === 'alternate') return
      try { term.scrollToBottom() } catch {}
      const activeBuffer = term.buffer.active
      rememberViewport(id, { line: activeBuffer.viewportY, atBottom: true })
    }
    const recoverModes = (): void => {
      if (!mounted || term.buffer.active.type === 'alternate') return
      if (!hasOrphanedModes(readEmulatorModes())) {
        if (interruptRecoveryPending) settleInterruptRecovery()
        else scrollPromptToBottom()
        return
      }
      batchedWrite(APP_OWNED_MODE_RESET, () => {
        if (interruptRecoveryPending) settleInterruptRecovery()
        else scrollPromptToBottom()
      })
      // The reset leaves the alternate screen and clears the TUI's scroll
      // region; park the viewport at the live bottom so the next prompt line —
      // the one the user types on after Ctrl-C — is visible instead of the
      // stale top lines. Run only after xterm has parsed the reset.
    }
    /** Returns whether the echo signal fired; the exit signal is deferred. */
    const watchOrphanedModes = (chunk: string): boolean => {
      // Fast path for the overwhelmingly common case: with no probe state
      // pending and no escape or bracket in the chunk, neither signal can
      // fire — both probes would be provable no-ops. This keeps the per-chunk
      // regex cost off the PTY fast path (plain shell output, streaming
      // tokens). Any pending carry/hits or any ESC/'[' falls through to the
      // exact same probes as before.
      if (
        modeRecovery.carry === '' &&
        modeRecovery.hits === 0 &&
        modeRecovery.titleCarry === '' &&
        !chunk.includes('\u001b') &&
        !chunk.includes('[')
      ) return false
      // Both probes see every chunk: the echo one has to, to count a burst,
      // and the title one, to track the child.
      const echoed = readEchoedMouseReports(modeRecovery, chunk)
      const child = readChildTitle(modeRecovery, chunk)
      if (child === 'started') {
        // Something is running again, so neither a pending recovery nor a
        // launch failure reported earlier is still describing this terminal.
        // The banner sits over the top of the card and nothing ever took it
        // down: it outlived the agent it was about, all the way through the
        // next successful launch.
        clearModeRecoveryTimer()
        clearInterruptRecoveryTimer()
        interruptRecoveryPending = false
        if (mounted) setStartupNotice(null)
      }
      if (child === 'exited') {
        // Held, not acted on. A launcher shim hands the title back on its way
        // to starting the real process, so a bare title is only an exit if
        // nothing supersedes it — the same test, and the same window, that
        // the launch-failure probe uses. Waiting also means the emulator's
        // state is read once it has settled rather than mid-teardown.
        clearModeRecoveryTimer()
        modeRecoveryTimer = setTimeout(() => {
          modeRecoveryTimer = null
          renderQueue.afterPending(recoverModes)
        }, EXIT_CONFIRM_MS)
      }
      return echoed
    }

    let interruptRecoveryTimer: ReturnType<typeof setTimeout> | null = null
    const clearInterruptRecoveryTimer = (): void => {
      if (interruptRecoveryTimer === null) return
      clearTimeout(interruptRecoveryTimer)
      interruptRecoveryTimer = null
    }
    /**
     * Second-chance recovery for Ctrl-C / Ctrl-D kills that the title probe
     * never sees (custom shell titles, shims that don't restore titles).
     *
     * Only acts on the self-evident corpse state: back on the normal buffer
     * with mouse tracking off, but origin mode / synchronized output / insert
     * mode left on or autowrap left off. A shell prompt never sets any of
     * those, while a still-running TUI is on the alternate buffer and/or
     * tracks the mouse — so this combination cannot be a live application
     * and resetting it is safe without any title evidence.
     */
    const recoverInterruptedShell = (): void => {
      if (!mounted) return
      const modes = readEmulatorModes()
      if (modes.bufferType !== 'normal' || (modes.mouseTracking ?? 'none') !== 'none') {
        // Ctrl+C was handled by a still-running TUI. Do not keep suppressing
        // legitimate viewport changes after that application remains alive.
        interruptRecoveryPending = false
        return
      }
      if (
        modes.originMode !== true &&
        modes.synchronizedOutputMode !== true &&
        modes.insertMode !== true &&
        modes.wraparoundMode !== false
      ) {
        settleInterruptRecovery()
        return
      }
      batchedWrite(APP_OWNED_MODE_RESET, settleInterruptRecovery)
    }
    const armInterruptRecovery = (): void => {
      clearInterruptRecoveryTimer()
      // The kill is asynchronous: ConPTY/node-pty has to deliver SIGINT,
      // the TUI has to die, and its last frame has to parse through the
      // render queue before the emulator state reads settled.
      interruptRecoveryTimer = setTimeout(() => {
        interruptRecoveryTimer = null
        renderQueue.afterPending(recoverInterruptedShell)
      }, 400)
    }

    const dataUnsub = window.api.terminal.onData(id, (data, deliveryId) => {
      watchStartupOutput(data)
      const echoed = watchOrphanedModes(data)
      batchedWrite(data, () => {
        if (deliveryId !== undefined) window.api.terminal.ackOutput(id, deliveryId)
      })
      // Immediate, unlike the exit signal: the echo is itself proof that a
      // shell's line editor is reading input right now, with nothing to wait
      // for and damage arriving with every pointer movement.
      if (echoed) renderQueue.afterPending(recoverModes)
    })
    // fit.fit() runs only after the resize settles, so send each resulting
    // geometry immediately. The PTY and xterm therefore move together, and a
    // repaint cannot land in a viewport that has already moved on.
    let lastSentResize: { cols: number; rows: number } | null = null
    const syncPtySize = (cols: number, rows: number): void => {
      if (lastSentResize?.cols === cols && lastSentResize?.rows === rows) return
      lastSentResize = { cols, rows }
      void window.api.terminal.resize(id, cols, rows)
    }
    // The reader and control thread can both report the same exit.
    let exitReported = false
    const exitUnsub = window.api.terminal.onExit(id, (code) => {
      if (exitReported) return
      exitReported = true
      clearInitialCommand(id)
      clearInterruptRecoveryTimer()
      markInterruptRecoveryPending()
      if (agentIdRef.current === 'codex' && agentId !== 'codex') agentIdRef.current = undefined
      // Through the render queue like everything else: a direct write would
      // overtake output still waiting in it and print the marker above the
      // shell's last lines.
      batchedWrite(`${APP_OWNED_MODE_RESET}\r\n\x1b[90m[Process exited${typeof code === 'number' ? ` (code ${code})` : ''}]\x1b[0m\r\n`, settleInterruptRecovery)
      onProcessExitRef.current?.()
    })

    let lockNotified = false
    const writePty = (data: string): void => {
      void window.api.terminal.write(id, data).then((result) => {
        if (result && 'error' in result) {
          if (!lockNotified) {
            lockNotified = true
            batchedWrite(`\r\n\x1b[33m[Input locked: ${result.error}]\x1b[0m\r\n`)
          }
          return
        }
        lockNotified = false
      }).catch(() => {
        if (!lockNotified) {
          lockNotified = true
          batchedWrite('\r\n\x1b[33m[Failed to write input]\x1b[0m\r\n')
        }
      })
    }
    let promptCapture = EMPTY_TERMINAL_PROMPT_CAPTURE
    const learnAgentFromCommand = (command: string): boolean => {
      if (agentIdentityLockedRef.current) return false
      const detected = attachmentAgent(command)
      if (!detected) return false
      agentIdRef.current = detected
      agentIdentityLockedRef.current = true
      return true
    }
    term.onData((data) => {
      // Replayed device queries must not send historical replies to a live shell.
      if (restoreInFlight) return
      // A deliberate interrupt is not a startup error, even if the CLI was
      // still inside its initial reconnect window.
      if (data.includes('\x03') || data.includes('\x04')) {
        startupProbe = null
        startupWatchUntil = 0
        clearStartupExitTimer()
        if (mounted) setStartupNotice(null)
      }
      // Ctrl-C (and Ctrl-D EOF) may kill the foreground TUI without cleanup,
      // leaving origin mode / scroll region behind — the "typing at the top"
      // state. Arm the second-chance recovery; it only acts on the corpse
      // state (normal buffer, no mouse, but TUI-only modes left on), so a TUI
      // that handles the key itself is never disturbed.
      if (data.includes('\x03') || data.includes('\x04')) {
        markInterruptRecoveryPending()
        armInterruptRecovery()
      }
      const captured = captureTerminalInput(promptCapture, data)
      promptCapture = captured.capture
      for (const submitted of captured.submitted) {
        const launchedAgent = learnAgentFromCommand(submitted.command)
        if (!launchedAgent) rememberPrompt(submitted.prompt)
      }
      writePty(data)
    })
    term.onResize(({ cols, rows }) => syncPtySize(cols, rows))

    const attachmentShortcut = (): string | null => imagePasteShortcut(agentIdRef.current, /win/i.test(navigator.platform) ? 'win32' : IS_MAC ? 'darwin' : 'linux')
    let attachmentQueue = Promise.resolve()
    const attachFiles = (files: File[]): Promise<void> => {
      const shortcut = attachmentShortcut()
      attachmentQueue = attachmentQueue.then(async () => {
        if (!mounted) return
        term.focus()
        await insertAttachments(files, shortcut, {
          getPath: (file) => window.api.media.getPathForFile(file as File),
          save: (bytes, ext) => window.api.media.saveBytesScratch(bytes, ext),
          stage: (bytes) => window.api.media.stageClipboardImage(bytes),
          paste: (text) => term.paste(text),
          write: writePty,
          report: (message) => batchedWrite(`\r\n\x1b[31m[${message.replace(/[\x00-\x1f\x7f]/g, ' ')}]\x1b[0m\r\n`),
          alive: () => mounted
        })
      }).catch((error) => {
        console.error('Attachment failed', error)
      })
      return attachmentQueue
    }


    const writeImagePath = (image: { path: string } | null, addTrailingSpace = false): void => {
      if (!image) return void batchedWrite('\r\n\x1b[33m[No image in clipboard]\x1b[0m\r\n')

      const pathText = /\s/.test(image.path) ? `"${image.path.replace(/"/g, '\\"')}"` : image.path
      const toInsert = addTrailingSpace ? `${pathText} ` : pathText
      term.paste(toInsert)
    }

    const pasteImageToAgent = async (bytes?: Uint8Array): Promise<boolean> => {
      const shortcut = attachmentShortcut()
      if (!shortcut) return false
      if (bytes) {
        const staged = await window.api.media.stageClipboardImage(bytes)
        if ('error' in staged) {
          batchedWrite(`\r\n\x1b[31m[${staged.error}]\x1b[0m\r\n`)
          return false
        }
      }
      if (!mounted) return false
      writePty(shortcut)
      return true
    }

    const isPasteShortcut = (event: KeyboardEvent): boolean => isTerminalPasteShortcut(event, IS_MAC)

    let lastPasteAt = 0
    const handlePaste = async (event?: ClipboardEvent): Promise<void> => {
      const now = Date.now()
      if (now - lastPasteAt < 150) return
      lastPasteAt = now

      try {
        const files = Array.from(event?.clipboardData?.files ?? [])
        if (!files.length && event?.clipboardData?.items) {
          for (const item of Array.from(event.clipboardData.items)) {
            if (item.kind !== 'file') continue
            const file = item.getAsFile()
            if (file) files.push(file)
          }
        }
        if (files.length) {
          await attachFiles(files)
          return
        }

        const img = await window.api.media.saveClipboardScratch()
        if (img && 'path' in img) {
          if (!await pasteImageToAgent()) {
            writeImagePath(img, true)
          }
          return
        }

        const text = event ? event.clipboardData?.getData('text/plain') : await window.api.media.readClipboardText()
        if (text) {
          term.paste(text)
        }
      } catch (err) {
        try {
          const fallbackText = await window.api.media.readClipboardText()
          if (fallbackText) term.paste(fallbackText)
        } catch {
          batchedWrite(`\r\n\x1b[31m[${err instanceof Error ? err.message : 'Failed to paste'}]\x1b[0m\r\n`)
        }
      }
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true

      const key = event.key.toLowerCase()

      if (IS_MAC && event.metaKey && !event.ctrlKey && !event.altKey) {
        if (key === 'c' && !event.shiftKey) {
          const selection = term.getSelection()
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => {})
            term.clearSelection()
            return false
          }
          writePty('\x03')
          return false
        }

        if (key === 'a' && !event.shiftKey) {
          term.selectAll()
          return false
        }
        if (key === 'k' && !event.shiftKey) {
          term.clear()
          return false
        }
      }

      if (isPasteShortcut(event)) {
        event.preventDefault()
        event.stopPropagation()
        void handlePaste()
        return false
      }

      if (event.shiftKey && event.key === 'PageUp') {
        term.scrollPages(-1)
        return false
      }
      if (event.shiftKey && event.key === 'PageDown') {
        term.scrollPages(1)
        return false
      }
      if (event.shiftKey && event.key === 'Home') {
        term.scrollToTop()
        return false
      }
      if (event.shiftKey && event.key === 'End') {
        term.scrollToBottom()
        return false
      }
      const fastScroll = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (event.shiftKey && event.key === 'ArrowUp') {
        term.scrollLines(fastScroll ? -5 : -1)
        return false
      }
      if (event.shiftKey && event.key === 'ArrowDown') {
        term.scrollLines(fastScroll ? 5 : 1)
        return false
      }
      return true
    })

    const focusShell = (): void => {
      if (!mounted || flippedRef.current) return
      try { term.focus() } catch {}
    }
    // Clicking the empty viewport padding below the last row must still land
    // in the shell: xterm's own click-to-focus only covers its screen
    // element, and the focusable widget frame around us otherwise keeps the
    // mousedown default focus for itself. The deferred pass runs after that
    // default, without preventing anything, so selection and drags keep
    // working untouched.
    const onPointerDownFocus = (event: PointerEvent): void => {
      if (event.button !== 0) return
      const target = event.target as HTMLElement | null
      if (target?.closest('button, input, [role="menu"]')) return
      focusShell()
      requestAnimationFrame(() => focusShell())
    }
    container.addEventListener('pointerdown', onPointerDownFocus)

    try {
      term.open(container)
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()





      if (surface === 'canvas') {
        // A fresh terminal must blink right away like a native one. The open
        // is synchronous but first paint (and a startup overlay teardown) can
        // still move focus afterwards, so re-assert past it.
        term.focus()
        requestAnimationFrame(() => focusShell())
        window.setTimeout(() => focusShell(), 80)
      }
    } catch (err) {
      console.error('failed to initialise terminal widget', err)
      batchedWrite('\r\n\x1b[31m[Terminal could not be initialised; retrying is safe]\x1b[0m\r\n')
    }




    // xterm reads a pointer position as a cell by dividing its offset inside
    // getBoundingClientRect() by the cell size. The rect is measured on screen
    // and therefore carries the canvas camera's zoom; the cell size is laid
    // out and does not. On a zoomed canvas every click was read that many rows
    // and columns too far, so a selection — and a click inside a TUI that
    // tracks the mouse — landed away from the pointer. See terminalPointerScale.
    const screenElement = container.querySelector('.xterm-screen') as HTMLElement | null
    const rewritten = new WeakSet<MouseEvent>()
    const currentScale = (): number =>
      screenElement ? pointerScale(screenElement.getBoundingClientRect().width, screenElement.offsetWidth) : 1
    const needsRewrite = (event: MouseEvent): boolean =>
      !!screenElement && !rewritten.has(event) && isPointerScaled(currentScale())
    const relay = (event: MouseEvent, target: EventTarget): void => {
      const rect = screenElement!.getBoundingClientRect()
      const { clientX, clientY } = unscalePointer(rect, currentScale(), event.clientX, event.clientY)
      const clone = new MouseEvent(event.type, {
        bubbles: true,
        cancelable: event.cancelable,
        composed: true,
        view: window,
        detail: event.detail,
        button: event.button,
        buttons: event.buttons,
        altKey: event.altKey,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
        clientX,
        clientY
      })
      rewritten.add(clone)
      target.dispatchEvent(clone)
    }
    let selectionDrag = false
    const endSelectionDrag = (): void => {
      if (!selectionDrag) return
      selectionDrag = false
      document.removeEventListener('mousemove', onDocumentMouse, true)
      document.removeEventListener('mouseup', onDocumentMouse, true)
    }
    // A selection drag keeps going outside the widget, and xterm follows it on
    // the document rather than on its own element.
    function onDocumentMouse(event: MouseEvent): void {
      if (!selectionDrag) return
      if (needsRewrite(event)) {
        event.stopPropagation()
        relay(event, document)
      }
      if (event.type === 'mouseup') endSelectionDrag()
    }
    const onContainerMouse = (event: MouseEvent): void => {
      if (!needsRewrite(event)) return
      event.stopPropagation()
      relay(event, event.target ?? container)
      if (event.type === 'mousedown' && event.button === 0 && !selectionDrag) {
        selectionDrag = true
        document.addEventListener('mousemove', onDocumentMouse, true)
        document.addEventListener('mouseup', onDocumentMouse, true)
      }
    }
    for (const type of ['mousedown', 'mousemove', 'dblclick']) {
      container.addEventListener(type, onContainerMouse as EventListener, true)
    }

    const handleResize = (): void => {
      try { fitPreservingViewport() } catch {}
    }
    const handleResolution = (): void => {
      if (!mounted) return
      try { fitPreservingViewport() } catch {}
    }
    window.addEventListener('resize', handleResize)
    const mediaQuery = window.matchMedia('(resolution: 96dpi)')
    mediaQuery.addEventListener('change', handleResolution)
    handleResize()





    const onKeyShortcut = (e: KeyboardEvent): void => {
      if (!container.contains(document.activeElement)) return

      if (isPasteShortcut(e)) {
        e.preventDefault()
        e.stopPropagation()
        void handlePaste()
        return
      }

      const key = e.key ? e.key.toLowerCase() : ''

      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return
      if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
        if (key === 'c') {
          const selection = term.getSelection()
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => {})
            term.clearSelection()
          }
        }
        if (key === 'x') {
          const selection = term.getSelection()
          if (selection) {
            void navigator.clipboard.writeText(selection).catch(() => {})
            term.clearSelection()
          }
        }
        return
      }
    }
    document.addEventListener('keydown', onKeyShortcut)


    // The menu used to be pinned to the bottom-right corner of the *window*
    // (nowhere near the click), a second right-click stacked another copy on
    // top of the first, and the only way it ever went away was a 2.5s timer —
    // so it could also vanish mid-reach. It is now anchored at the pointer,
    // never more than one at a time, and dismissed the way a menu should be.
    let openMenu: { el: HTMLElement; close: () => void } | null = null
    const closeTerminalMenu = (): void => openMenu?.close()
    const onContextMenu = (e: MouseEvent): void => {
      e.preventDefault()
      closeTerminalMenu()
      const selection = term.getSelection()
      const hasSelection = !!selection?.trim()

      const menu = document.createElement('div')
      menu.setAttribute('role', 'menu')
      menu.style.cssText =
        'position:fixed;min-width:132px;background:var(--tok-color-bg-raise,#16161a);' +
        'border:1px solid var(--tok-color-line,#2a2a2e);border-radius:8px;padding:4px;' +
        'box-shadow:0 8px 24px rgba(8,9,11,.55);z-index:99999;display:flex;flex-direction:column;gap:2px;'

      const itemButtons: HTMLButtonElement[] = []
      const close = (): void => {
        if (openMenu?.el !== menu) return
        openMenu = null
        window.removeEventListener('pointerdown', onOutside, true)
        window.removeEventListener('keydown', onMenuKey, true)
        window.removeEventListener('blur', close)
        window.removeEventListener('resize', close)
        menu.remove()
        // Focus went into the menu when it opened, so it has to come back —
        // otherwise dismissing left the page with nothing focused and the
        // next keystroke went nowhere instead of to the shell.
        if (mounted) term.focus()
      }
      const onOutside = (event: Event): void => {
        if (!menu.contains(event.target as Node)) close()
      }
      // Arrow navigation to match the canvas context menu, which had it while
      // this one could only be driven with the pointer.
      const moveFocus = (step: number): void => {
        if (itemButtons.length === 0) return
        const current = itemButtons.indexOf(document.activeElement as HTMLButtonElement)
        const next = (current + step + itemButtons.length) % itemButtons.length
        itemButtons[current < 0 ? (step > 0 ? 0 : itemButtons.length - 1) : next]?.focus()
      }
      const onMenuKey = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
          event.stopPropagation()
          close()
        } else if (event.key === 'ArrowDown') {
          event.preventDefault()
          event.stopPropagation()
          moveFocus(1)
        } else if (event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          moveFocus(-1)
        } else if (event.key === 'Home' || event.key === 'End') {
          event.preventDefault()
          event.stopPropagation()
          itemButtons[event.key === 'Home' ? 0 : itemButtons.length - 1]?.focus()
        }
      }

      const addItem = (label: string, run: () => void): void => {
        const button = document.createElement('button')
        button.type = 'button'
        button.setAttribute('role', 'menuitem')
        button.textContent = label
        button.style.cssText =
          'width:100%;padding:5px 10px;border:none;border-radius:5px;background:transparent;' +
          'color:var(--tok-color-text,#e8e8ea);font:inherit;font-size:12px;text-align:left;cursor:pointer;'
        button.onmouseenter = (): void => {
          button.style.background = 'var(--tok-color-bg-hover,#232328)'
        }
        button.onmouseleave = (): void => {
          button.style.background = 'transparent'
        }
        button.onclick = (): void => {
          close()
          run()
        }
        button.onfocus = (): void => {
          button.style.background = 'var(--tok-color-bg-hover,#232328)'
        }
        button.onblur = (): void => {
          button.style.background = 'transparent'
        }
        itemButtons.push(button)
        menu.appendChild(button)
      }

      if (hasSelection) {
        addItem('Copy', () => void navigator.clipboard.writeText(selection).catch(() => {}))
      }
      addItem('Paste', () => void handlePaste())
      if (hasSelection) addItem('Clear selection', () => term.clearSelection())
      // An application that dies without restoring the modes it set leaves the
      // terminal in them, and the shell it dropped back to never asked for any
      // of it. The most visible case is mouse tracking: every pointer movement
      // over the widget then types a report into the prompt. Nothing else can
      // clear that — the shell is still alive, so there is no exit to hook —
      // so this is the way out.
      addItem('Reset terminal', () => {
        batchedWrite(APP_OWNED_MODE_RESET)
        term.clearSelection()
      })

      document.body.appendChild(menu)
      // Measure once attached so the menu can never open past the viewport
      // edge (the old fixed corner at least never did this by accident).
      const rect = menu.getBoundingClientRect()
      const left = Math.max(4, Math.min(e.clientX, window.innerWidth - rect.width - 4))
      const top = Math.max(4, Math.min(e.clientY, window.innerHeight - rect.height - 4))
      menu.style.left = `${left}px`
      menu.style.top = `${top}px`

      openMenu = { el: menu, close }
      itemButtons[0]?.focus()
      window.addEventListener('pointerdown', onOutside, true)
      window.addEventListener('keydown', onMenuKey, true)
      window.addEventListener('blur', close)
      window.addEventListener('resize', close)
    }
    container.addEventListener('contextmenu', onContextMenu)




    const onFocusIn = (): void => window.api.terminal.setFocused(true, id)
    // xterm moves focus between its own helper textarea and the screen
    // element, and each hop fires focusout. Reporting a blur for those made
    // the main process briefly believe no terminal was focused, so an `orc
    // tell` with no explicit target could land in the wrong terminal.
    const onFocusOut = (event: FocusEvent): void => {
      const next = event.relatedTarget
      if (next instanceof Node && container.contains(next)) return
      window.api.terminal.setFocused(false, id)
    }
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)


















    let wheelAcc = 0
    // The 16px constant this replaced did not match the rendered row at any
    // zoom or DPI other than the one it was picked at, so a wheel notch
    // scrolled a different distance than it looked like it should.
    const rowHeight = (): number => {
      const screen = container.querySelector<HTMLElement>('.xterm-screen')
      const height = screen?.clientHeight ?? 0
      const rows = term.rows || 1
      return height > 0 ? height / rows : 16
    }
    const onWheel = (event: WheelEvent): void => {
      if (term.buffer.active.type === 'alternate') return
      // Ctrl/Cmd + wheel is the canvas zoom gesture. Swallowing it meant the
      // canvas could not be zoomed while the pointer sat over a terminal —
      // and terminals cover most of the canvas. Alt keeps the fast-scroll
      // role it used to share with Ctrl.
      if (IS_MAC ? event.metaKey : event.ctrlKey) return

      event.preventDefault()
      event.stopPropagation()
      let delta = event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        delta *= 20
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= 200
      }

      if (event.altKey) {
        delta *= 4
      }

      wheelAcc += delta
      const lineHeight = rowHeight()
      const lines = Math.trunc(wheelAcc / lineHeight)
      if (lines !== 0) {
        wheelAcc -= lines * lineHeight
        term.scrollLines(lines)
      }
    }
    container.addEventListener('wheel', onWheel, { capture: true, passive: false })




    const onPaste = (event: ClipboardEvent): void => {
      const eventTarget = event.target
      const ownsEvent = container.contains(document.activeElement) || (eventTarget instanceof Node && container.contains(eventTarget))
      if (!ownsEvent) return
      event.preventDefault()
      event.stopPropagation()
      void handlePaste(event)
    }
    container.addEventListener('paste', onPaste, true)



    const onDragEnter = (event: DragEvent): void => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('text/session-id')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragOver = (event: DragEvent): void => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('text/session-id')) return
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      if (Array.from(event.dataTransfer?.types ?? []).includes('text/session-id')) return
      event.preventDefault()
      event.stopPropagation()
      const dt = event.dataTransfer
      let dropped: File[] = Array.from(dt?.files ?? [])
      if (dropped.length === 0 && dt?.items) {
        for (const item of Array.from(dt.items)) {
          if (item.kind === 'file') {
            const f = item.getAsFile()
            if (f) dropped.push(f)
          }
        }
      }
      if (dropped.length === 0) return




      void attachFiles(dropped)
    }
    container.addEventListener('dragenter', onDragEnter)
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('drop', onDrop)







    void window.api.terminal.create(id, term.cols, term.rows, titleRef.current).then((result) => {




      if (!mounted) {
        // No detach here: `mounted` is only false once the effect cleanup has
        // run, and that cleanup already detached. Detaching twice for a single
        // attach unbalanced the main process's mount count, which then dropped
        // the *next* widget generation's output — a terminal that took input
        // and painted nothing.
        //
        // The queued command stays queued: this generation is gone without
        // having typed it, so the next one has to.
        return
      }
      if (!result || !('ok' in result) || !result.ok) {
        const err = result && 'error' in result ? result.error : undefined
        batchedWrite(`\r\n\x1b[31m[Failed to launch terminal${err ? `: ${err}` : ''}]\x1b[0m\r\n`)


        if (mounted) setConnecting(false)
        return
      }
      let viewportRestoredAfterWrite = false
      const launchQueuedCommand = (): void => {
        const queued = peekInitialCommand(id)
        if (!mounted || exitReported || !queued) return
        const waitMs = initialCommandWaitMs(id)
        if (waitMs > 0) {
          if (queuedLaunchTimer !== null) clearTimeout(queuedLaunchTimer)
          queuedLaunchTimer = setTimeout(() => {
            queuedLaunchTimer = null
            launchQueuedCommand()
          }, waitMs)
          return
        }
        if (
          initialCommandVerdict({
            live: result.live === true,
            bufferType: term.buffer.active.type === 'alternate' ? 'alternate' : 'normal',
            mouseTracking: term.modes.mouseTrackingMode
          }) === 'already-running'
        ) {
          // Something already owns this terminal — typing here would put the
          // command into its input, not run it. The agent it would have
          // started is the thing already running, so the command is done.
          learnAgentFromCommand(queued)
          markInitialCommandDelivered(id)
          return
        }
        learnAgentFromCommand(queued)
        // Arm before writing. A missing command or an allocator abort can
        // produce output and return to the prompt before the IPC write promise
        // settles; arming in the continuation loses the only failure text.
        setStartupNotice(null)
        startupProbe = createStartupProbe(queued)
        startupWatchUntil = Date.now() + STARTUP_WATCH_MS
        void deliverInitialCommand(id, (command) => window.api.terminal.write(id, `${command}${cachedSubmit}`)).then((result) => {
          if ('error' in result) {
            startupProbe = null
            clearStartupExitTimer()
            if (mounted) batchedWrite(`\r\n\x1b[31m[Failed to start command: ${result.error}]\x1b[0m\r\n`)
            return
          }
        }).catch(() => {
          startupProbe = null
          clearStartupExitTimer()
          if (mounted) batchedWrite('\r\n\x1b[31m[Failed to start command]\x1b[0m\r\n')
        })
      }
      if (result.scrollback) {
        // A reconnect can hand back up to ~512KB of scrollback. One write()
        // of that size blocks the UI thread (frozen input, stuck Ctrl+C), so
        // the restore is paced in slices chained through the write callback,
        // which fires once the slice has been parsed. Marker included in the
        // same chain so the two can never interleave. The leading SGR reset
        // is invisible and guards against history truncated mid-sequence by
        // the main-process ring buffer.
        // Replaying history also replays the private-mode switches the old
        // foreground app turned on. For a session that is NOT live the shell
        // underneath is brand new and never asked for any of them, but the
        // emulator is now left in, above all, mouse-tracking mode — so every
        // pointer move over the widget types an SGR mouse report straight into
        // the prompt (`^[[<35;40;18M…`), which is unusable and looks like the
        // terminal has been corrupted. A live re-attach preserves parser state
        // so queued output can complete the process's unfinished frame.
        const restoredScrollback = result.scrollback
        writePaced(terminalRestoreData(restoredScrollback, result.live === true), () => {
          restoreViewportAfterLayout()
          launchQueuedCommand()
          // The replayed history is terminal output, and it goes straight to
          // the parser rather than through onData — so the recovery probes
          // never saw it. That mattered for a live re-attach, which keeps the
          // history verbatim: a widget remounting onto a shell whose agent had
          // crashed replayed the crash's `1049h` and mouse modes and stranded
          // itself all over again, with no further output coming to notice it
          // by. Feeding the history in here re-reads the same child-exit the
          // crash left in it. Done from the completion callback so the pause
          // before acting is measured against a finished restore, and so the
          // emulator state it then reads is the settled one.
          watchOrphanedModes(restoredScrollback)
        })
        viewportRestoredAfterWrite = true
      }

      if (result.live && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          fitPreservingViewport()
        } catch {

        }
      }



      if (!viewportRestoredAfterWrite) restoreViewportAfterLayout()

      // A live re-attach gets the command too. `live` only means the pty was
      // already running when this widget connected; it says nothing about
      // whether the command was ever typed, and a still-queued entry says it
      // was not. Discarding it here was the second half of the lost-command
      // bug — a widget torn down mid-connect leaves the shell running, so its
      // replacement always arrived to `live: true` and threw the command away.
      // That is why closing some code sessions left the survivors sitting at a
      // bare prompt with the agent never started.
      if (!viewportRestoredAfterWrite) launchQueuedCommand()
      if (mounted && !restoreInFlight) setConnecting(false)
    }).catch(() => {
      // Leave the command queued: nothing was typed, so a retry still owes it.
      if (mounted) {
        batchedWrite('\r\n\x1b[31m[Failed to launch terminal]\x1b[0m\r\n')
        setConnecting(false)
      }
    })

    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        try {
          fitPreservingViewport()
        } catch (err) {

          console.warn('terminal resize skipped', err)
        }
      })
    })
    observer.observe(container)

    return () => {
      mounted = false
      // Never persist alternate-buffer offsets: they describe the dead TUI's
      // frame, and replaying them onto the normal buffer pins the viewport
      // to the top after the TUI exits.
      if (term.buffer.active.type !== 'alternate') {
        const activeBuffer = term.buffer.active
        rememberViewport(id, {
          line: activeBuffer.viewportY,
          atBottom: activeBuffer.viewportY >= activeBuffer.baseY
        })
      }
      flushChannel.port1.close()
      flushChannel.port2.close()
      cancelRestore?.()
      clearStartupExitTimer()
      if (queuedLaunchTimer !== null) clearTimeout(queuedLaunchTimer)
      clearModeRecoveryTimer()
      clearInterruptRecoveryTimer()
      renderQueue.dispose()
      if (fitTimer !== null) {
        clearTimeout(fitTimer)
        fitTimer = null
      }
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeAnchorGeneration++
      observer.disconnect()
      endSelectionDrag()
      for (const type of ['mousedown', 'mousemove', 'dblclick']) {
        container.removeEventListener(type, onContainerMouse as EventListener, true)
      }
      container.removeEventListener('pointerdown', onPointerDownFocus)
      window.removeEventListener('resize', handleResize)
      mediaQuery.removeEventListener('change', handleResolution)
      document.removeEventListener('keydown', onKeyShortcut)
      container.removeEventListener('contextmenu', onContextMenu)
      closeTerminalMenu()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('dragenter', onDragEnter)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
      container.removeEventListener('wheel', onWheel, true)
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      window.api.terminal.setFocused(false, id)
      window.api.terminal.detach(id)
      dataUnsub()
      exitUnsub()
      scrollDisposable.dispose()
      writeParsedDisposable.dispose()

      try {
        term.dispose()
      } catch (err) {







        console.warn('terminal dispose threw', err)
      }
      if (termRef.current === term) termRef.current = null
    }
  }, [id, surface, rememberPrompt])

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={containerRef}
        className={`term-shell term relative h-full w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
          surface === 'canvas' ? 'is-canvas-term p-0' : 'is-code-term px-1.5 py-0.5'
        } ${flipped ? 'invisible pointer-events-none' : ''}`}
        data-testid="terminal-xterm"
        aria-hidden={flipped}
      >
        {connecting && (
          <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center">
            <span className="animate-pulse rounded-panel bg-bg-raise px-2.5 py-1 text-[11px] text-text-faint">
              Connecting…
            </span>
          </div>
        )}
      </div>
      {startupNotice && !flipped && (
        <div
          role={startupNotice.tone === 'error' ? 'alert' : 'status'}
          data-testid="terminal-startup-failure"
          className={`pointer-events-auto absolute inset-x-1.5 top-1.5 z-20 flex items-start gap-2 rounded-panel border bg-bg-panel/95 px-2.5 py-2 text-[11px] leading-snug text-text shadow-[0_8px_26px_rgba(0,0,0,0.35)] ${startupNotice.tone === 'error' ? 'border-danger/40' : 'border-line'}`}
        >
          {startupNotice.tone === 'error'
            ? <AlertTriangle size={14} className="mt-[1px] flex-none text-danger" aria-hidden="true" />
            : <TerminalIcon size={14} className="mt-[1px] flex-none text-text-faint" aria-hidden="true" />}
          <span className="min-w-0 flex-1">{startupNotice.message}</span>
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => setStartupNotice(null)}
            className="flex-none rounded-panel px-1 text-text-faint transition-colors hover:text-text"
          >
            <X size={12} />
          </button>
        </div>
      )}
      {flipped && (
        <div
          className="absolute inset-0 flex items-center justify-center overflow-auto bg-bg px-[8%] py-[7%] text-center"
          data-testid="terminal-flip-card"
        >
          <div className="flex max-h-full max-w-[900px] items-center gap-3 text-text">
            <MessageSquareText size={18} className="flex-none text-text-dim" aria-hidden="true" />
            <p className={`m-0 whitespace-pre-wrap break-words font-medium leading-snug ${lastPrompt ? 'text-[clamp(14px,2vw,26px)]' : 'text-sm text-text-faint'}`}>
              {lastPrompt || 'No user prompt yet'}
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

export default React.memo(TerminalWidget)
