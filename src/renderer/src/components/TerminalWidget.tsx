import React, { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from 'xterm'
import { FitAddon } from 'xterm-addon-fit'
import { Unicode11Addon } from 'xterm-addon-unicode11'
import 'xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { pasteHasImage } from '../lib/paste'
import { takeInitialCommand } from '../lib/pendingTerminalCommands'
import { IS_MAC } from '../lib/platform'
import { palette } from '../design'


const cachedSubmit = '\r'




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



  onProcessExit?: () => void
}


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
    background: isCanvas ? 'transparent' : palette.terminalSolid,
    cursorAccent: palette.wallpaperBase
  }
}

function TerminalWidget({ id, surface = 'canvas', onProcessExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)


  const [connecting, setConnecting] = useState(true)
  const { theme } = useTheme()

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
      lineHeight: 1.15,
      scrollback: 5000,
      cursorBlink: true,



      cursorInactiveStyle: 'none',
      convertEol: false,



      allowProposedApi: true
    })
    termRef.current = term
    let mounted = true
    const fit = new FitAddon()
    term.loadAddon(fit)


    const unicode11 = new Unicode11Addon()
    term.loadAddon(unicode11)
    term.unicode.activeVersion = '11'
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




      closeTimer = setTimeout(() => onProcessExitRef.current?.(), 8000)
    })

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


    const writeImagePath = (image: { path: string } | null, addTrailingSpace = false): void => {
      if (!image) return void term.write('\r\n\x1b[33m[No image in clipboard]\x1b[0m\r\n')



      const pathText = /\s/.test(image.path) ? `"${image.path.replace(/"/g, '\\"')}"` : image.path
      writePty(addTrailingSpace ? `${pathText} ` : pathText)
    }

    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true




      if (IS_MAC && event.metaKey && !event.ctrlKey && !event.altKey) {
        const key = event.key.toLowerCase()


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


        if (key === 'v') return true
        if (key === 'a' && !event.shiftKey) {
          term.selectAll()
          return false
        }
        if (key === 'k' && !event.shiftKey) {

          term.clear()
          return false
        }
      }





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





      if (surface === 'canvas') term.focus()
    } catch (err) {



      console.error('failed to initialise terminal widget', err)
      term.write('\r\n\x1b[31m[Terminal could not be initialised; retrying is safe]\x1b[0m\r\n')
    }


    const handleResize = (): void => {
      if (!mounted || container.clientWidth === 0 || container.clientHeight === 0) return
      try { fit.fit() } catch {}
    }
    const handleResolution = (): void => {
      if (!mounted) return
      try { fit.fit() } catch {}
    }
    window.addEventListener('resize', handleResize)
    const mediaQuery = window.matchMedia('(resolution: 96dpi)')
    mediaQuery.addEventListener('change', handleResolution)
    handleResize()





    const onKeyShortcut = (e: KeyboardEvent): void => {


      if (!container.contains(document.activeElement)) return
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey) return
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
    }
    document.addEventListener('keydown', onKeyShortcut)


    const onContextMenu = (e: MouseEvent): void => {
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
      menu.style.boxShadow = '0 4px 12px rgba(8,9,11,.6)'
      menu.style.zIndex = '99999'
      menu.innerHTML = `
        ${hasSelection
          ? `<button style="width:100%;margin-bottom:4px;padding:4px;border:none;border-radius:4px;background:var(--tok-color-bg-panel);color:var(--tok-color-text);font-size:12px;cursor:pointer;" onclick="void navigator.clipboard.writeText('${selection}')">Copy</button>`
          : ''}
        ${!hasSelection
          ? `<button style="width:100%;padding:4px;border:none;border-radius:4px;background:var(--tok-color-bg-panel);color:var(--tok-color-text);font-size:12px;cursor:pointer;" onclick="void navigator.clipboard.readText().then(t=>term.paste(t)).catch(()=>{})">Paste</button>`
          : ''}
      `
      document.body.appendChild(menu)
      setTimeout(() => document.body.removeChild(menu), 1200)
    }
    container.addEventListener('contextmenu', onContextMenu)




    const onFocusIn = (): void => window.api.terminal.setFocused(true, id)
    const onFocusOut = (): void => window.api.terminal.setFocused(false, id)
    container.addEventListener('focusin', onFocusIn)
    container.addEventListener('focusout', onFocusOut)


















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




    const onPaste = (event: ClipboardEvent): void => {



      const eventTarget = event.target
      const ownsEvent = container.contains(document.activeElement) || (eventTarget instanceof Node && container.contains(eventTarget))
      if (!ownsEvent) return
      event.preventDefault()
      event.stopPropagation()




      if (pasteHasImage(event)) {
        writePty('\x16')
        return
      }
      const text = event.clipboardData?.getData('text/plain')
      if (!text) {



        writePty('\x16')
        return
      }









      term.paste(text)
    }
    container.addEventListener('paste', onPaste, true)



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







    void window.api.terminal.create(id, term.cols, term.rows).then((result) => {




      if (!mounted) {
        takeInitialCommand(id)
        window.api.terminal.detach(id)
        return
      }
      if (!result || !('ok' in result) || !result.ok) {
        const err = result && 'error' in result ? result.error : undefined
        term.write(`\r\n\x1b[31m[Failed to launch terminal${err ? `: ${err}` : ''}]\x1b[0m\r\n`)


        takeInitialCommand(id)
        if (mounted) setConnecting(false)
        return
      }
      let viewportRestoredAfterWrite = false
      if (result.scrollback) {




        term.write(result.scrollback, () => restoreViewportAfterLayout())
        viewportRestoredAfterWrite = true
        if (!result.live) {
          term.write('\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n')
        }
      }

      if (result.live && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          const anchor = captureViewportAnchor()
          fit.fit()
          scheduleResizeAnchorRestore(anchor)
        } catch {

        }
      }



      if (result.live) takeInitialCommand(id)


      if (!viewportRestoredAfterWrite) restoreViewportAfterLayout()




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



          const anchor = captureViewportAnchor()
          fit.fit()
          scheduleResizeAnchorRestore(anchor)
        } catch (err) {

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
      window.removeEventListener('resize', handleResize)
      mediaQuery.removeEventListener('change', handleResolution)
      document.removeEventListener('keydown', onKeyShortcut)
      container.removeEventListener('contextmenu', onContextMenu)
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







        console.warn('terminal dispose threw', err)
      }
      if (termRef.current === term) termRef.current = null
    }
  }, [id, surface])

  return (
    <div
      ref={containerRef}
      className={`term-shell term relative h-full w-full p-2 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        surface === 'canvas' ? 'is-canvas-term' : 'is-code-term'
      }`}
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
