import React, { useEffect, useRef } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { WebglAddon } from 'xterm-addon-webgl'
import 'xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { takeInitialCommand } from '../lib/pendingTerminalCommands'
import { palette } from '../design'

/** Windows conpty wants CRLF for "Enter" to actually submit the line. */
const cachedSubmit = typeof navigator !== 'undefined' && /windows/i.test(navigator.userAgent) ? '\r\n' : '\r'

interface Props {
  id: string
  /** Called once the underlying process exits on its own (not via the widget's
   *  own close button) — lets the widget remove itself instead of sitting on
   *  the canvas as a dead shell showing only "[Process exited]". */
  onProcessExit?: () => void
}

/** Standard-ish ANSI palette for dark terminals — not grayscale. Apps like
 *  Claude Code colour their UI with these slots; mapping them all to grey made
 *  every TUI look monochrome. */
const BASE_COLORS = {
  foreground: '#e8e8ea',
  cursor: '#e8e8ea',
  selectionBackground: 'rgba(120, 160, 255, 0.35)',
  black: '#1a1a1e',
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

/**
 * One flat fill: xterm paints the exact colour the frame and header use, so
 * the whole shell reads as a single slab in every theme. Opaque is safe for
 * TUI detection too — OSC 11 reports the RGB alone, which reads as dark.
 */
function xtermTheme(_appTheme: ThemeName): ITheme {
  return { ...BASE_COLORS, background: palette.terminalSolid, cursorAccent: palette.wallpaperBase }
}

export default function TerminalWidget({ id, onProcessExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const { theme } = useTheme()
  // Mount effect is once-per-id; keep the latest exit handler without re-spawning xterm.
  const onProcessExitRef = useRef(onProcessExit)
  onProcessExitRef.current = onProcessExit

  // Re-theme in place on toggle so scrollback and the running shell survive.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme)
  }, [theme])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: xtermTheme(theme),
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      lineHeight: 1.15,
      scrollback: 5000,
      cursorBlink: true,
      convertEol: false
    })
    termRef.current = term
    let mounted = true
    const fit = new FitAddon()
    term.loadAddon(fit)

    const dataUnsub = window.api.terminal.onData(id, (data) => term.write(data))
    let closeTimer: ReturnType<typeof setTimeout> | null = null
    let initialCmdTimer: ReturnType<typeof setTimeout> | null = null
    const exitUnsub = window.api.terminal.onExit(id, (code) => {
      term.write(`\r\n\x1b[90m[Process exited${typeof code === 'number' ? ` (code ${code})` : ''}]\x1b[0m\r\n`)
      // Give the user time to read the final output before the widget
      // vanishes — 1.2s was barely enough to notice a process had died. A dead
      // shell shouldn't linger forever, but the trace has to stay readable
      // first (CANV-19).
      closeTimer = setTimeout(() => onProcessExitRef.current?.(), 8000)
    })
    // One in-band notice while an agent holds the lock — not one per keystroke.
    let lockNotified = false
    const writePty = (data: string): void => {
      void window.api.terminal.write(id, data).then((result) => {
        if (result && 'error' in result) {
          if (!lockNotified) {
            lockNotified = true
            term.write(`\r\n\x1b[33m[Input locked: ${result.error}]\x1b[0m\r\n`)
          }
          return
        }
        lockNotified = false
      }).catch(() => {
        if (!lockNotified) {
          lockNotified = true
          term.write('\r\n\x1b[33m[Failed to write input]\x1b[0m\r\n')
        }
      })
    }
    term.onData((data) => writePty(data))
    term.onResize(({ cols, rows }) => window.api.terminal.resize(id, cols, rows))

    /** A shell takes a path, not pixels, so a picture is written as a quoted path. */
    const writeImagePath = (image: { name: string; path: string } | null): void => {
      if (!image) return void term.write('\r\n\x1b[33m[No image in clipboard]\x1b[0m\r\n')
      writePty(`"${image.path}"`)
      term.write(`\x1b[90m[Image pasted: ${image.name}]\x1b[0m`)
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.altKey && event.key.toLowerCase() === 'v') {
        void window.api.media.saveClipboard().then(writeImagePath).catch(() => {
          term.write('\r\n\x1b[31m[Failed to save image]\x1b[0m\r\n')
        })
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
      if (event.shiftKey && event.key === 'ArrowUp') {
        term.scrollLines(-1)
        return false
      }
      if (event.shiftKey && event.key === 'ArrowDown') {
        term.scrollLines(1)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowUp') {
        term.scrollLines(-5)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'ArrowDown') {
        term.scrollLines(5)
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'Home') {
        term.scrollToTop()
        return false
      }
      if (event.ctrlKey && event.shiftKey && event.key === 'End') {
        term.scrollToBottom()
        return false
      }
      return true
    })

    try {
      term.open(container)
      if (container.clientWidth > 0 && container.clientHeight > 0) fit.fit()
    } catch (err) {
      // A canvas redraw can detach the host between React's effect and xterm's
      // canvas setup. Report it in the pane instead of letting it take down
      // the whole renderer process.
      console.error('failed to initialise terminal widget', err)
      term.write('\r\n\x1b[31m[Terminal could not be initialised; retrying is safe]\x1b[0m\r\n')
    }

    // Glyphs render on the GPU instead of xterm's default 2D canvas path,
    // which is what keeps a busy shell (a build log, an agent streaming
    // tokens) from pegging a CPU core. Best-effort: some hosts have no WebGL
    // context to give (headless CI, software rendering, too many contexts
    // open across many terminal widgets at once) — xterm's default renderer
    // is a perfectly fine fallback, so a failure here is silent rather than
    // surfaced in the pane.
    //
    // Deferred a frame: creating a WebGL context means the GPU driver spins
    // up and xterm compiles its shaders, which is 10-40ms of real work — real
    // enough that doing it synchronously in the mount effect was on the
    // critical path of opening a terminal, delaying the first paint of a pane
    // that was otherwise already ready to show text. One frame is enough for
    // the initial (2D-rendered) paint to land first; the swap to WebGL then
    // happens invisibly a moment later.
    let webglRaf: number | null = requestAnimationFrame(() => {
      webglRaf = null
      if (!mounted) return
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch (err) {
        console.warn('xterm webgl renderer unavailable, using default renderer', err)
      }
    })

    // The main process intercepts Ctrl+C/X/A/Z while a terminal holds focus
    // (menu accelerators would otherwise win over the pty), so it needs to
    // know when this widget's xterm textarea is focused.
    const onFocusIn = (): void => window.api.terminal.setFocused(true, id)
    const onFocusOut = (): void => window.api.terminal.setFocused(false, id)
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)

    // Smooth and responsive terminal scrollback navigation on mouse wheel.
    //
    // Who owns a wheel tick depends on the buffer, the way it does in a real
    // terminal (Windows Terminal, iTerm, …):
    //
    //  - alternate buffer: the app owns the screen and there is no scrollback
    //    to move, so the tick belongs to the app. Bail out and let xterm's own
    //    listeners forward a proper mouse report (or synthesise arrow keys when
    //    mouse tracking is off).
    //  - normal buffer: the scrollback is ours to move, even while the app has
    //    mouse tracking on. Deferring to xterm there is what broke scrolling in
    //    Claude Code / Gemini CLI: those run in the normal buffer *and* enable
    //    mouse tracking, so every tick was encoded as a mouse report the TUI
    //    ignores, xterm called preventDefault(), and the viewport never moved.
    //
    // Capture phase + stopPropagation keeps xterm's own listeners (bound on the
    // descendant .xterm element) from also acting on the tick we handled.
    let wheelAcc = 0
    const onWheel = (event: WheelEvent): void => {
      if (term.buffer.active.type === 'alternate') return

      event.preventDefault()
      event.stopPropagation()
      let delta = event.deltaY
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        delta *= 20
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= 200
      }

      if (event.altKey || event.ctrlKey) {
        delta *= 4
      }

      wheelAcc += delta
      const lineHeight = 16
      const lines = Math.trunc(wheelAcc / lineHeight)
      if (lines !== 0) {
        wheelAcc -= lines * lineHeight
        term.scrollLines(lines)
      }
    }
    container.addEventListener('wheel', onWheel, { capture: true, passive: false })

    // Capture phase + stopPropagation: the event never reaches xterm's own
    // textarea paste handler, so the text is written to the pty a single time.
    // Handling it on bubble instead is what caused every Ctrl+V to paste twice.
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      // Ctrl+V on a picture writes its path too, so the image case no longer
      // depends on remembering Alt+V.
      if (pasteHasImage(event)) {
        void saveImageFromPaste(event)
          .then(writeImagePath)
          .catch(() => term.write('\r\n\x1b[31m[Failed to save image]\x1b[0m\r\n'))
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (text) writePty(text.replace(/\r?\n/g, '\r'))
    }
    container.addEventListener('paste', onPaste, true)

    // A failed spawn must not look like a working terminal: the widget reports
    // it in-band instead of silently mounting a dead pane.
    // On reconnect (`live`), the process never died (folder switch) — paint the
    // live buffer and keep typing into the same Claude/shell session.
    // On a true restart, paint the disk snapshot as static text and show that
    // the old process is gone (ARCHITECTURE Option A).
    void window.api.terminal.create(id, term.cols, term.rows).then((result) => {
      // The IPC request may finish after this React instance unmounted. Detach
      // parks the pty (does not kill it) so a remount can reconnect.
      if (!mounted) {
        window.api.terminal.detach(id)
        return
      }
      if (!result || !('ok' in result) || !result.ok) {
        const err = result && 'error' in result ? result.error : undefined
        term.write(`\r\n\x1b[31m[Failed to launch terminal${err ? `: ${err}` : ''}]\x1b[0m\r\n`)
        return
      }
      if (result.scrollback) {
        term.write(result.scrollback)
        if (!result.live) {
          term.write('\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n')
        }
      }
      // Nudge full-screen TUIs (Claude Code, etc.) to reflow against this pane.
      if (result.live && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          fit.fit()
        } catch {
          /* host may have unmounted mid-reconnect */
        }
      }
      // A fresh shell (never a reconnect — retyping into a resumed session
      // would double-launch whatever the user had running) gets its queued
      // command, if the Code launcher left one. Delayed a beat so the shell
      // has actually attached stdin before the keystrokes arrive.
      if (!result.live) {
        const queued = takeInitialCommand(id)
        if (queued) {
          initialCmdTimer = setTimeout(() => {
            if (mounted) writePty(`${queued}${cachedSubmit}`)
          }, 300)
        }
      }
    }).catch(() => {
      if (mounted) term.write('\r\n\x1b[31m[Failed to launch terminal]\x1b[0m\r\n')
    })

    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
        try {
          fit.fit()
        } catch (err) {
          // Ignore a resize queued for a node that has just been unmounted.
          console.warn('terminal resize skipped', err)
        }
      })
    })
    observer.observe(container)

    return () => {
      mounted = false
      if (webglRaf !== null) cancelAnimationFrame(webglRaf)
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('wheel', onWheel, true)
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      window.api.terminal.setFocused(false, id)
      window.api.terminal.detach(id)
      if (closeTimer) clearTimeout(closeTimer)
      if (initialCmdTimer) clearTimeout(initialCmdTimer)
      dataUnsub()
      exitUnsub()
      try {
        term.dispose()
      } catch (err) {
        // xterm-addon-webgl's teardown hook rebuilds the DOM renderer via
        // `_core._createRenderer()` and hands it straight to
        // `renderService.setRenderer()`; if this widget unmounts fast enough
        // that `_core` is already mid-teardown, `_createRenderer()` comes
        // back undefined and xterm throws reading `.onRequestRedraw` off it.
        // The terminal is going away either way, so swallow it instead of
        // letting it take down the whole canvas via the error boundary.
        console.warn('terminal dispose threw', err)
      }
      if (termRef.current === term) termRef.current = null
    }
  }, [id])

  return <div ref={containerRef} className="term-shell term h-full w-full py-1.5 pr-0 pl-2" data-testid="terminal-xterm" />
}
