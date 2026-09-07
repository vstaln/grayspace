import React, { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { pasteHasImage } from '../lib/paste'
import { takeInitialCommand } from '../lib/pendingTerminalCommands'
import { IS_MAC } from '../lib/platform'
import { palette } from '../design'

/** A carriage return is the portable terminal keycode for Enter. */
const cachedSubmit = '\r'

// WidgetFrame can temporarily unmount a terminal while moving it between the
// canvas and the maximized layer. Keep the viewport independent from xterm's
// DOM lifetime so a remount does not unexpectedly jump to the top or bottom.
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
  /** Canvas terminals use the wallpaper as their surface; Code terminals do not. */
  surface?: 'canvas' | 'code'
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

/**
 * One flat fill: xterm paints the exact colour the frame and header use, so
 * the whole shell reads as a single slab in every theme. Keep the xterm canvas
 * opaque: fullscreen TUIs (Gemini, Claude, etc.) repaint through an alternate
 * buffer and transparent canvas layers can lose glyphs against the wallpaper.
 */
function xtermTheme(_appTheme: ThemeName, surface: 'canvas' | 'code'): ITheme {
  return {
    ...BASE_COLORS,
    background: palette.terminalSolid,
    cursorAccent: palette.wallpaperBase
  }
}

function TerminalWidget({ id, surface = 'canvas', onProcessExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  // True until terminal.create() resolves — the pane would otherwise sit blank
  // with no indication that a shell is on its way.
  const [connecting, setConnecting] = useState(true)
  const { theme } = useTheme()
  // Mount effect is once-per-id; keep the latest exit handler without re-spawning xterm.
  const onProcessExitRef = useRef(onProcessExit)
  onProcessExitRef.current = onProcessExit

  // Re-theme in place on toggle so scrollback and the running shell survive.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = xtermTheme(theme, surface)
  }, [theme, surface])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      theme: xtermTheme(theme, surface),
      fontSize: 13,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      lineHeight: 1.15,
      scrollback: 5000,
      cursorBlink: true,
      // A background terminal must not advertise a fake blinking input caret
      // while an agent (for example Codex) owns the session. Keep the normal
      // blinking cursor only when this terminal is focused for user input.
      cursorInactiveStyle: 'none',
      convertEol: false
    })
    termRef.current = term
    let mounted = true
    const fit = new FitAddon()
    term.loadAddon(fit)
    const pendingWrites: string[] = []
    let writeRaf: number | null = null
    const flushWrites = (): void => {
      writeRaf = null
      if (pendingWrites.length === 0) return
      const batch = pendingWrites.splice(0, pendingWrites.length).join('')
      term.write(batch)
    }
    const batchedWrite = (data: string): void => {
      pendingWrites.push(data)
      if (writeRaf === null) writeRaf = requestAnimationFrame(flushWrites)
    }
    const restoreViewport = (saved?: { line: number; atBottom: boolean }): void => {
      const viewport = saved ?? terminalViewportById.get(id)
      if (!viewport) return
      if (viewport.atBottom) term.scrollToBottom()
      else term.scrollToLine(Math.min(viewport.line, term.buffer.active.baseY))
    }
    // Moving a maximized widget between the canvas layer and the overlay can
    // cause one or two layout passes after xterm has painted. Restore again on
    // the next frames so FitAddon cannot leave a previously scrolled terminal
    // at line zero.
    const restoreViewportAfterLayout = (): void => {
      if (!mounted) return
      restoreViewport()
      requestAnimationFrame(() => {
        if (!mounted) return
        restoreViewport()
        requestAnimationFrame(() => {
          if (mounted) restoreViewport()
        })
      })
    }
    type ViewportAnchor = { line: number; atBottom: boolean }
    const captureViewportAnchor = (): ViewportAnchor => {
      const activeBuffer = term.buffer.active
      return {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY
      }
    }
    const applyViewportAnchor = (anchor: ViewportAnchor): void => {
      if (!mounted) return
      if (anchor.atBottom) term.scrollToBottom()
      else term.scrollToLine(Math.min(anchor.line, term.buffer.active.baseY))
    }

    // fit.fit() first resizes xterm locally and then terminal.resize reaches
    // the PTY. Full-screen CLIs repaint asynchronously in response to that
    // second step; their clear/redraw sequence can reset xterm's viewport
    // after our immediate restoration. Keep the pre-resize anchor alive for
    // the short repaint window and re-apply it after parsed output as well.
    let resizeAnchor: ViewportAnchor | null = null
    let resizeAnchorGeneration = 0
    let resizeRestoreUntil = 0
    let resizeRestoreTimerShort: ReturnType<typeof setTimeout> | null = null
    let resizeRestoreTimerLong: ReturnType<typeof setTimeout> | null = null
    const restoreResizeAnchor = (generation: number): void => {
      if (generation !== resizeAnchorGeneration || !resizeAnchor) return
      applyViewportAnchor(resizeAnchor)
    }
    const scheduleResizeAnchorRestore = (anchor: ViewportAnchor): void => {
      resizeAnchor = anchor
      resizeAnchorGeneration++
      const generation = resizeAnchorGeneration
      resizeRestoreUntil = performance.now() + 300
      if (resizeRestoreTimerShort) clearTimeout(resizeRestoreTimerShort)
      if (resizeRestoreTimerLong) clearTimeout(resizeRestoreTimerLong)
      applyViewportAnchor(anchor)
      requestAnimationFrame(() => restoreResizeAnchor(generation))
      resizeRestoreTimerShort = setTimeout(() => restoreResizeAnchor(generation), 60)
      resizeRestoreTimerLong = setTimeout(() => restoreResizeAnchor(generation), 180)
    }
    const writeParsedDisposable = term.onWriteParsed(() => {
      if (!resizeAnchor || performance.now() > resizeRestoreUntil) return
      const generation = resizeAnchorGeneration
      requestAnimationFrame(() => restoreResizeAnchor(generation))
    })
    const scrollDisposable = term.onScroll(() => {
      const activeBuffer = term.buffer.active
      rememberViewport(id, {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY
      })
    })

    const dataUnsub = window.api.terminal.onData(id, (data) => batchedWrite(data))
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

    const isImageFile = (f: { name?: string; type?: string }): boolean => {
      if (f.type && f.type.startsWith('image/')) return true
      const name = (f.name || '').toLowerCase()
      return /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(name)
    }

    /** Put a dropped image's saved path into the agent's input. */
    const writeImagePath = (image: { path: string } | null, addTrailingSpace = false): void => {
      if (!image) return void term.write('\r\n\x1b[33m[No image in clipboard]\x1b[0m\r\n')
      // Keep the path as one input value even when the user's profile or
      // workspace contains spaces. Quotes are understood by the CLI prompt
      // parser and do not turn the path into several unrelated words.
      const pathText = /\s/.test(image.path) ? `"${image.path.replace(/"/g, '\\"')}"` : image.path
      writePty(addTrailingSpace ? `${pathText} ` : pathText)
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
        void window.api.media
          .saveClipboardScratch()
          .then((img) => writeImagePath(img, false))
          .catch((err) => {
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
      term.focus()
    } catch (err) {
      // A canvas redraw can detach the host between React's effect and xterm's
      // canvas setup. Report it in the pane instead of letting it take down
      // the whole renderer process.
      console.error('failed to initialise terminal widget', err)
      term.write('\r\n\x1b[31m[Terminal could not be initialised; retrying is safe]\x1b[0m\r\n')
    }

    // Refit on zoom / DPR change: subscribe window resize + matchMedia(resolution) change -> fit.fit()
    useEffect(() => {
      const handleResize = (): void => {
        if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
        try { fit.fit() } catch {}
      }
      const handleResolution = (): void => {
        if (!mounted) return
        try { fit.fit() } catch {}
      }
      window.addEventListener('resize', handleResize)
      window.matchMedia('(resolution: 96dpi)').addEventListener('change', handleResolution)
      handleResize()
      return () => {
        window.removeEventListener('resize', handleResize)
        window.matchMedia('(resolution: 96dpi)').removeEventListener('change', handleResolution)
      }
    }, [mounted, container, fit])

    // Copy / Paste hotkeys: Ctrl+Shift+C / Ctrl+Shift+V (Windows/Linux) and
    // Cmd+Shift+C / Cmd+Shift+V (macOS) with Shift as the cross-platform
    // modifier that works alongside Ctrl/Cmd. Existing native Ctrl+C/X/V and
    // Cmd+C/V remain functional for their standard roles.
    useEffect(() => {
      const handler = (e: KeyboardEvent): void => {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return // standard Ctrl/Cmd+C/V, let native handle
        if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
          e.preventDefault()
          const key = e.key.toLowerCase()
          if (key === 'c') {
            const selection = term.getSelection()
            if (selection) {
              void navigator.clipboard.writeText(selection).catch(() => {})
              term.clearSelection()
            }
          }
          if (key === 'v') {
            void navigator.clipboard.readText().then((text) => term.paste(text)).catch(() => {})
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
        // Without modifier — fallback to copy last selection via input or do nothing
      }
      document.addEventListener('keydown', handler)
      return () => document.removeEventListener('keydown', handler)
    }, [term])

    // Minimal context menu on right-click: Copy/Paste on terminal selection
    useEffect(() => {
      const handler = (e: MouseEvent): void => {
        if (e.button !== 2) return
        e.preventDefault()
        const selection = term.getSelection()
        const hasSelection = !!selection?.trim()
        const menu = document.createElement('div')
        menu.style.position = 'fixed'
        menu.style.right = '10px'
        menu.style.bottom = '10px'
        menu.style.background = 'var(--bg-raise)'
        menu.style.border = '1px solid var(--border-line-soft)'
        menu.style.borderRadius = '6px'
        menu.style.padding = '8px'
        menu.style.boxShadow = '0 4px 12px rgba(0,0,0,.15)'
        menu.style.zIndex = '99999'
        menu.innerHTML = `
          ${hasSelection
            ? `<button style="width:100%;margin-bottom:4px;padding:4px;border:none;border-radius:4px;background:#3182ce;color:white;font-size:12px;cursor:pointer;" onclick="void navigator.clipboard.writeText('${selection}')">Copy</button>`
            : ''}
          ${!hasSelection
            ? `<button style="width:100%;padding:4px;border:none;border-radius:4px;background:#e2e8f0;font-size:12px;cursor:pointer;" onclick="void navigator.clipboard.readText().then(t=>term.paste(t)).catch(()=>{})">Paste</button>`
            : ''}
        `
        document.body.appendChild(menu)
        setTimeout(() => document.body.removeChild(menu), 1200)
      }
      container.addEventListener('contextmenu', handler)
      return () => container.removeEventListener('contextmenu', handler)
    }, [term])

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
    // Capture phase + stopPropagation: the event never reaches xterm's own
    // textarea paste handler, so the text is written to the pty a single time.
    // Handling it on bubble instead is what caused every Ctrl+V to paste twice.
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      // The image bytes cannot travel through a PTY. Forward the original
      // Ctrl+V control character instead; the active CLI reads the same OS
      // clipboard and creates its own real image attachment. Sending a text
      // token such as `[Image #1]` loses the attachment completely.
      if (pasteHasImage(event)) {
        writePty('\x16')
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (!text) {
        // Some screenshot tools expose only the native clipboard bitmap, not
        // a ClipboardEvent file item. Forward Ctrl+V for that shape too; an
        // empty clipboard is harmless and remains a no-op in the CLI.
        writePty('\x16')
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
    // Finder/Explorer, anything) writes its path for images or quoted path for documents.
    const onDragEnter = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDragOver = (event: DragEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (event: DragEvent): void => {
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

      // Sequential, not a parallel loop: several files each write their own
      // path/token into the same line, and racing reads would interleave them into
      // an unusable argument list.
      void (async () => {
        for (const file of dropped) {
          try {
            if (isImageFile(file)) {
              const bytes = new Uint8Array(await file.arrayBuffer())
              const ext = file.name.includes('.') ? file.name.split('.').pop()! : file.type.split('/')[1] || 'png'
              const saved = await window.api.media.saveBytesScratch(bytes, ext)
              if (saved && 'path' in saved) {
                writeImagePath(saved, true)
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
    container.addEventListener('dragenter', onDragEnter)
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
        if (mounted) setConnecting(false)
        return
      }
      let viewportRestoredAfterWrite = false
      if (result.scrollback) {
        // xterm parses large writes asynchronously. Restoring immediately after
        // `write()` is too early: the parser can finish afterward and move the
        // viewport again. Use its completion callback so reconnects in Code and
        // Canvas preserve the user's actual scroll position.
        term.write(result.scrollback, () => restoreViewportAfterLayout())
        viewportRestoredAfterWrite = true
        if (!result.live) {
          term.write('\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n')
        }
      }
      // Nudge full-screen TUIs (Claude Code, etc.) to reflow against this pane.
      if (result.live && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          const anchor = captureViewportAnchor()
          fit.fit()
          scheduleResizeAnchorRestore(anchor)
        } catch {
          /* host may have unmounted mid-reconnect */
        }
      }
      // A persisted Code session may reconnect to a still-live PTY. Drain the
      // restart command in that case so it cannot remain queued and execute
      // unexpectedly on a later remount.
      if (result.live) takeInitialCommand(id)
      // Restoring the saved scrollback can itself move xterm's viewport. Do it
      // after the reconnect paint and after any PTY reflow has been requested.
      if (!viewportRestoredAfterWrite) restoreViewportAfterLayout()
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
      if (mounted) setConnecting(false)
    }).catch(() => {
      // Same leak concern as the !ok branch: drain whatever was queued.
      takeInitialCommand(id)
      if (mounted) {
        term.write('\r\n\x1b[31m[Failed to launch terminal]\x1b[0m\r\n')
        setConnecting(false)
      }
    })

    let resizeRaf: number | null = null
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null
        if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
        try {
          // xterm can reset the viewport to the top when the number of rows
          // changes. Preserve the exact scroll position across canvas resize;
          // only a terminal that was already at the bottom remains at bottom.
          const anchor = captureViewportAnchor()
          fit.fit()
          scheduleResizeAnchorRestore(anchor)
        } catch (err) {
          // Ignore a resize queued for a node that has just been unmounted.
          console.warn('terminal resize skipped', err)
        }
      })
    })
    observer.observe(container)

    return () => {
      mounted = false
      const activeBuffer = term.buffer.active
      rememberViewport(id, {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY
      })
      if (writeRaf !== null) { cancelAnimationFrame(writeRaf); writeRaf = null; pendingWrites.length = 0 }
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeAnchorGeneration++
      if (resizeRestoreTimerShort) clearTimeout(resizeRestoreTimerShort)
      if (resizeRestoreTimerLong) clearTimeout(resizeRestoreTimerLong)
      observer.disconnect()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('dragenter', onDragEnter)
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
      scrollDisposable.dispose()
      writeParsedDisposable.dispose()
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

  return (
    <div
      ref={containerRef}
      className="term-shell term relative h-full w-full p-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 focus-within:ring-1 focus-within:ring-inset focus-within:ring-text-faint/50"
      data-testid="terminal-xterm"
    >
      {connecting && (
        <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="animate-pulse rounded bg-bg-raise px-2.5 py-1 text-[11px] text-text-faint">
            Connecting…
          </span>
        </div>
      )}
    </div>
  )
}

export default React.memo(TerminalWidget)
