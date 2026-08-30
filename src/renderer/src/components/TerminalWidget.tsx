import React, { useEffect, useRef } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { takeInitialCommand } from '../lib/pendingTerminalCommands'
import { IS_MAC } from '../lib/platform'
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

      // macOS clipboard chords. Control stays with the shell there (Ctrl+C is
      // SIGINT, Ctrl+A is begin-of-line), so copy/paste/select ride Command the
      // way they do in Terminal.app and iTerm.
      if (IS_MAC && event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase()
        // Cmd+C copies the selection, and falls through to the shell as SIGINT
        // when there is nothing selected — exactly what iTerm does.
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
        // Cmd+V is handled by the container's paste listener (which also covers
        // images); swallowing it here would stop that event from ever firing.
        if (key === 'v') return true
        if (key === 'a' && !event.shiftKey) {
          term.selectAll()
          return false
        }
        if (key === 'k' && !event.shiftKey) {
          // Cmd+K clears the screen, the macOS terminal convention.
          term.clear()
          return false
        }
      }

      // AltGr on European layouts reports as Ctrl+Alt: an AltGr+V keystroke is
      // a shell character, not a clipboard-image request — let it through
      // instead of hijacking it (UI-audit). On macOS Option+V is a real glyph
      // (√), so the image chord is Cmd+V's paste path there instead.
      if (!IS_MAC && event.altKey && !event.ctrlKey && event.key.toLowerCase() === 'v') {
        void window.api.media.saveClipboardScratch().then(writeImagePath).catch((err) => {
          term.write(
            `\r\n\x1b[31m[${err instanceof Error ? err.message : 'Failed to save image'}]\x1b[0m\r\n`
          )
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
      // Fast scrollback jumps. Command on macOS, Control elsewhere — on a Mac
      // Ctrl+Shift+Arrow is a system text-selection chord, and Control there
      // belongs to the shell in any case.
      const fastScroll = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey
      if (fastScroll && event.shiftKey && event.key === 'ArrowUp') {
        term.scrollLines(-5)
        return false
      }
      if (fastScroll && event.shiftKey && event.key === 'ArrowDown') {
        term.scrollLines(5)
        return false
      }
      if (fastScroll && event.shiftKey && event.key === 'Home') {
        term.scrollToTop()
        return false
      }
      if (fastScroll && event.shiftKey && event.key === 'End') {
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

      // Accelerate on the "scroll faster" modifier. macOS reports a trackpad
      // pinch as ctrlKey+wheel, so Control must not count there — a pinch would
      // otherwise fling the scrollback four lines at a time.
      if (event.altKey || (event.ctrlKey && !IS_MAC)) {
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
      // Ctrl+V / Cmd+V on a picture writes its path too, so the image case no
      // longer depends on remembering Alt+V.
      if (pasteHasImage(event)) {
        void saveImageFromPaste(event, { scratch: true })
          .then(writeImagePath)
          .catch((err) =>
            term.write(
              `\r\n\x1b[31m[${err instanceof Error ? err.message : 'Failed to save image'}]\x1b[0m\r\n`
            )
          )
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (!text) {
        // Nothing in the event's own payload. That is the normal shape of a
        // macOS screenshot (Cmd+Shift+4) and of an image copied out of some
        // apps: the bitmap reaches Electron's native clipboard but never gets
        // exposed as a clipboardData item, so pasteHasImage() above cannot see
        // it and an image paste would silently do nothing. Ask the native
        // clipboard directly before giving up — this is what makes pasting a
        // screenshot into a Code session work the same on macOS as on Windows.
        void window.api.media
          .saveClipboardScratch()
          .then((image) => {
            // Genuinely empty clipboard: stay silent rather than nagging.
            if (image) writeImagePath(image)
          })
          .catch(() => {
            /* nothing usable on the clipboard — a paste of nothing is not an error */
          })
        return
      }
      // term.paste(), not a raw pty write. Writing the text straight through
      // dropped bracketed paste: the shell (and every TUI agent — Claude Code,
      // Gemini CLI) saw a plain run of CRs and treated each pasted line as a
      // submitted command, so pasting a code block ran it line by line instead
      // of dropping it in as one block. term.paste() wraps the text in
      // \x1b[200~ / \x1b[201~ whenever the app has bracketed paste on, falls
      // back to the plain text when it doesn't, and normalises newlines either
      // way. It reaches the pty through the same onData handler as typing, so
      // the write still happens exactly once (TERM-paste-bracketed).
      term.paste(text)
    }
    container.addEventListener('paste', onPaste, true)

    // Dropping a file (a screenshot dragged off the desktop, an image from
    // Finder/Explorer, anything) writes its quoted path the same way a
    // clipboard-pasted picture does — the terminal only ever wants a path.
    const onDragOver = (event: DragEvent): void => {
      if (!event.dataTransfer?.types.includes('Files')) return
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
      const files = event.dataTransfer?.files
      if (!files || files.length === 0) return
      event.preventDefault()
      const dropped = Array.from(files)
      // Sequential, not a parallel loop: several files each write their own
      // path into the same line, and racing reads would interleave them into
      // an unusable argument list.
      void (async () => {
        for (const file of dropped) {
          try {
            // An image goes through the same content-addressed scratch copy
            // as a clipboard paste (saveImageFromPaste) rather than its raw OS
            // path: a screenshot's real path is long, often has spaces and,
            // on a non-English Windows install, non-ASCII characters (e.g.
            // "Снимок экрана ....png") — exactly the kind of path some
            // CLIs/agents mis-parse even quoted. Non-image files keep their
            // real path; there's no such mangling concern and copying, say, a
            // dropped video would just burn scratch space for nothing.
            if (file.type.startsWith('image/')) {
              const bytes = new Uint8Array(await file.arrayBuffer())
              const ext = file.name.includes('.') ? file.name.split('.').pop()! : file.type.split('/')[1]
              const saved = await window.api.media.saveBytesScratch(bytes, ext)
              if (saved && 'path' in saved) {
                writeImagePath(saved)
                // The paste path deliberately writes no trailing space; a drop
                // may carry several files, so each path needs its separator.
                writePty(' ')
              } else if (saved && 'error' in saved) {
                term.write(`\r\n\x1b[31m[${saved.error}]\x1b[0m\r\n`)
              }
              continue
            }
            const path = window.api.media.getPathForFile(file)
            if (!path) continue
            // A double quote is a legal filename character off Windows, and
            // an unescaped one would close the quoting early and hand the
            // shell a mangled command.
            writePty(`"${path.replace(/"/g, '\\"')}" `)
            term.write(`\x1b[90m[Dropped: ${file.name}]\x1b[0m`)
          } catch (err) {
            term.write(
              `\r\n\x1b[31m[${err instanceof Error ? err.message : 'Failed to read dropped file'}]\x1b[0m\r\n`
            )
          }
        }
      })()
    }
    container.addEventListener('dragover', onDragOver)
    container.addEventListener('drop', onDrop)

    // A failed spawn must not look like a working terminal: the widget reports
    // it in-band instead of silently mounting a dead pane.
    // On reconnect (`live`), the process never died (folder switch) — paint the
    // live buffer and keep typing into the same Claude/shell session.
    // On a true restart, paint the disk snapshot as static text and show that
    // the old process is gone (ARCHITECTURE Option A).
    void window.api.terminal.create(id, term.cols, term.rows).then((result) => {
      // The IPC request may finish after this React instance unmounted. Detach
      // parks the pty (does not kill it) so a remount can reconnect.
      // Drain any queued launcher command either way — this mount can no
      // longer deliver it, and leaving it would leak the module-level map.
      if (!mounted) {
        takeInitialCommand(id)
        window.api.terminal.detach(id)
        return
      }
      if (!result || !('ok' in result) || !result.ok) {
        const err = result && 'error' in result ? result.error : undefined
        term.write(`\r\n\x1b[31m[Failed to launch terminal${err ? `: ${err}` : ''}]\x1b[0m\r\n`)
        // No shell to type into — drain so a dead spawn doesn't leave the
        // queued command in the map forever.
        takeInitialCommand(id)
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
      // Same leak concern as the !ok branch: drain whatever was queued.
      takeInitialCommand(id)
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
          // xterm can move the viewport when the number of rows changes. Keep
          // a live chat pinned to the bottom across pane resizes, while
          // respecting an intentional scrollback position.
          const activeBuffer = term.buffer.active
          const wasAtBottom = activeBuffer.viewportY >= activeBuffer.baseY
          fit.fit()
          if (wasAtBottom) term.scrollToBottom()
        } catch (err) {
          // Ignore a resize queued for a node that has just been unmounted.
          console.warn('terminal resize skipped', err)
        }
      })
    })
    observer.observe(container)

    return () => {
      mounted = false
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      observer.disconnect()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('dragover', onDragOver)
      container.removeEventListener('drop', onDrop)
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
