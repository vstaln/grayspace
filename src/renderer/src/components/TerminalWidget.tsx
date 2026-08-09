import React, { useEffect, useRef } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import 'xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { palette } from '../design'

interface Props {
  id: string
}

const BASE_COLORS = {
  foreground: '#e2e2e2',
  cursor: '#d7d7d7',
  selectionBackground: 'rgba(255, 255, 255, 0.28)',
  black: '#111111', red: '#8f8f8f', green: '#a3a3a3', yellow: '#b7b7b7',
  blue: '#989898', magenta: '#adadad', cyan: '#bcbcbc', white: '#dedede',
  brightBlack: '#555555', brightRed: '#b0b0b0', brightGreen: '#bdbdbd', brightYellow: '#c8c8c8',
  brightBlue: '#b5b5b5', brightMagenta: '#c2c2c2', brightCyan: '#d0d0d0', brightWhite: '#ffffff'
}

/**
 * xterm paints its own background onto a canvas, which no stylesheet can reach,
 * so the shell's fill has to be handed to it directly. Reading the same token
 * `.term-shell` uses keeps the two from drifting — a mismatch shows up as a
 * lighter rectangle inside the widget.
 */
function xtermTheme(_appTheme: ThemeName): ITheme {
  return { ...BASE_COLORS, background: palette.terminalGlass, cursorAccent: palette.wallpaperBase }
}

export default function TerminalWidget({ id }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const { theme } = useTheme()

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
    const fit = new FitAddon()
    term.loadAddon(fit)

    const dataUnsub = window.api.terminal.onData(id, (data) => term.write(data))
    const exitUnsub = window.api.terminal.onExit(id, (code) =>
      term.write(`\r\n\x1b[90m[процесс завершён${typeof code === 'number' ? ` (код ${code})` : ''}]\x1b[0m\r\n`)
    )
    term.onData((data) => window.api.terminal.write(id, data))
    term.onResize(({ cols, rows }) => window.api.terminal.resize(id, cols, rows))

    /** A shell takes a path, not pixels, so a picture is written as a quoted path. */
    const writeImagePath = (image: { name: string; path: string } | null): void => {
      if (!image) return void term.write('\r\n\x1b[33m[в буфере обмена нет изображения]\x1b[0m\r\n')
      window.api.terminal.write(id, `"${image.path}"`)
      term.write(`\x1b[90m[изображение вставлено: ${image.name}]\x1b[0m`)
    }

    // Alt+V stays as the explicit "paste the clipboard picture" key. Plain text
    // paste is deliberately NOT handled here — the capture-phase 'paste'
    // listener below owns it, so it happens exactly once.
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true
      if (event.altKey && event.key.toLowerCase() === 'v') {
        void window.api.media.saveClipboard().then(writeImagePath)
        return false
      }
      return true
    })

    term.open(container)
    fit.fit()

    // The main process intercepts Ctrl+C/X/A/Z while a terminal holds focus
    // (menu accelerators would otherwise win over the pty), so it needs to
    // know when this widget's xterm textarea is focused.
    const onFocusIn = (): void => window.api.terminal.setFocused(true, id)
    const onFocusOut = (): void => window.api.terminal.setFocused(false, id)
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)

    // Capture phase + stopPropagation: the event never reaches xterm's own
    // textarea paste handler, so the text is written to the pty a single time.
    // Handling it on bubble instead is what caused every Ctrl+V to paste twice.
    const onPaste = (event: ClipboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      // Ctrl+V on a picture writes its path too, so the image case no longer
      // depends on remembering Alt+V.
      if (pasteHasImage(event)) {
        void saveImageFromPaste(event).then(writeImagePath)
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (text) window.api.terminal.write(id, text.replace(/\r?\n/g, '\r'))
    }
    container.addEventListener('paste', onPaste, true)

    // A failed spawn must not look like a working terminal: the widget reports
    // it in-band instead of silently mounting a dead pane.
    void window.api.terminal.create(id, term.cols, term.rows).then((result) => {
      if (!result.ok) {
        term.write(`\r\n\x1b[31m[не удалось запустить терминал${result.error ? `: ${result.error}` : ''}]\x1b[0m\r\n`)
      }
    })

    const observer = new ResizeObserver(() => fit.fit())
    observer.observe(container)

    return () => {
      observer.disconnect()
      container.removeEventListener('paste', onPaste, true)
      container.removeEventListener('focusin', onFocusIn)
      container.removeEventListener('focusout', onFocusOut)
      window.api.terminal.setFocused(false, id)
      window.api.terminal.dispose(id)
      dataUnsub()
      exitUnsub()
      term.dispose()
      if (termRef.current === term) termRef.current = null
    }
  }, [id])

  return <div ref={containerRef} className="term-shell term h-full w-full py-1.5 pr-0 pl-2" />
}
