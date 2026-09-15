import React, { useEffect, useRef, useState } from 'react'
import { Terminal, ITheme } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { ThemeName, useTheme } from '../theme'
import { attachmentAgent, imagePasteShortcut, insertAttachments, isTerminalPasteShortcut } from '../lib/terminalAttachments'
import { clearInitialCommand, markInitialCommandDelivered, peekInitialCommand } from '../lib/pendingTerminalCommands'
import { IS_MAC } from '../lib/platform'
import { TerminalRenderQueue } from '../lib/terminalRenderQueue'
import { palette } from '../ui/tokens'


const cachedSubmit = '\r'

/**
 * Turns off every private mode that belongs to a *running foreground
 * application* rather than to the terminal itself: the mouse-reporting modes
 * and their coordinate encodings, focus reporting, and bracketed paste.
 * Cursor visibility and autowrap are restored alongside, since an application
 * that died without cleaning up tends to leave those off too.
 *
 * Used when replaying saved scrollback into a terminal whose shell is new.
 * The history carries whatever the previous application switched on, and
 * replaying it puts the emulator back into those modes even though nothing is
 * running that asked for them — most visibly mouse tracking, which then
 * reports every pointer movement into the prompt as `^[[<35;40;18M` noise.
 */
const APP_OWNED_MODE_RESET =
  '\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l' +
  '\x1b[?1004l\x1b[?1005l\x1b[?1006l\x1b[?1015l' +
  '\x1b[?2004l\x1b[?2026l\x1b[?25h\x1b[?7h\x1b[?6l\x1b[4l\x1b[r'




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
  agentId?: string
  /**
   * Accepted and persisted per widget, but nothing in here reads it yet — the
   * paste/drop attachment paths below run the same way whatever it is set to.
   * Left in place because the plumbing (and its localStorage entry) belongs to
   * a feature that is still being built, not to dead code.
   */
  attachmentMode?: boolean
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
    // xterm's color parser rejects the CSS keyword `transparent` and falls
    // back to opaque black. Use an 8-digit hex color so the viewport and DOM
    // renderer keep a transparent background on canvas terminals.
    background: isCanvas ? '#08080800' : (surface === 'code' ? '#080808' : palette.terminalSolid),
    cursorAccent: palette.wallpaperBase
  }
}

function TerminalWidget({ id, surface = 'canvas', agentId, onProcessExit }: Props): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
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
      lineHeight: 1,
      scrollback: 5000,
      cursorBlink: true,
      cursorInactiveStyle: 'outline',
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
    const batchedWrite = (data: string): void => {
      renderQueue.push(data)
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
      if (resizeRestoreTimer !== null) {
        clearTimeout(resizeRestoreTimer)
        resizeRestoreTimer = null
      }
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
      // Fullscreen TUIs live on the alternate screen buffer — forcing scroll
      // positions there corrupts the rendered frame.
      if (term.buffer.active.type === 'alternate') return
      if (anchor.atBottom) term.scrollToBottom()
      else term.scrollToLine(Math.min(anchor.line, term.buffer.active.baseY))
    }






    let resizeAnchor: ViewportAnchor | null = null
    let resizeAnchorGeneration = 0
    let resizeRestoreUntil = 0
    let resizeRestoreTimer: ReturnType<typeof setTimeout> | null = null
    const restoreResizeAnchor = (generation: number): void => {
      if (restoreInFlight || generation !== resizeAnchorGeneration || !resizeAnchor) return
      applyViewportAnchor(resizeAnchor)
    }
    const scheduleResizeAnchorRestore = (anchor: ViewportAnchor): void => {
      if (restoreInFlight) return
      resizeAnchor = anchor
      resizeAnchorGeneration++
      const generation = resizeAnchorGeneration
      resizeRestoreUntil = performance.now() + 300
      if (resizeRestoreTimer) clearTimeout(resizeRestoreTimer)
      // Three staggered restores on top of the immediate one meant a single
      // resize yanked the viewport four times; the RAF already lands after
      // xterm has reflowed, and the timer only covers a reflow that spilled
      // into a later frame.
      applyViewportAnchor(anchor)
      requestAnimationFrame(() => restoreResizeAnchor(generation))
      resizeRestoreTimer = setTimeout(() => restoreResizeAnchor(generation), 150)
    }
    const writeParsedDisposable = term.onWriteParsed(() => {
      if (!resizeAnchor || performance.now() > resizeRestoreUntil) return
      const generation = resizeAnchorGeneration
      requestAnimationFrame(() => restoreResizeAnchor(generation))
    })
    const scrollDisposable = term.onScroll(() => {
      // Streaming scrollback changes viewportY while baseY is still growing.
      // Those intermediate positions are not user intent and must not replace
      // the saved bottom-follow state used after restore.
      if (restoreInFlight) return
      const activeBuffer = term.buffer.active
      rememberViewport(id, {
        line: activeBuffer.viewportY,
        atBottom: activeBuffer.viewportY >= activeBuffer.baseY
      })
    })

    const dataUnsub = window.api.terminal.onData(id, (data) => batchedWrite(data))
    let resizeSendRaf: number | null = null
    let resizeSendTimer: ReturnType<typeof setTimeout> | null = null
    let pendingResize: { cols: number; rows: number } | null = null
    let lastSentResize: { cols: number; rows: number } | null = null
    const flushResize = (): void => {
      if (resizeSendRaf !== null) {
        cancelAnimationFrame(resizeSendRaf)
        resizeSendRaf = null
      }
      if (resizeSendTimer !== null) {
        clearTimeout(resizeSendTimer)
        resizeSendTimer = null
      }
      const next = pendingResize
      pendingResize = null
      if (!next || (lastSentResize?.cols === next.cols && lastSentResize?.rows === next.rows)) return
      lastSentResize = next
      void window.api.terminal.resize(id, next.cols, next.rows)
    }
    const queueResize = (cols: number, rows: number): void => {
      pendingResize = { cols, rows }
      if (resizeSendRaf === null) resizeSendRaf = requestAnimationFrame(flushResize)
      // Same RAF-starvation hazard as output writes: never leave a geometry
      // update stranded when frames stop.
      if (resizeSendTimer === null) resizeSendTimer = setTimeout(flushResize, 250)
    }
    // The reader and control thread can both report the same exit.
    let exitReported = false
    const exitUnsub = window.api.terminal.onExit(id, (code) => {
      if (exitReported) return
      exitReported = true
      clearInitialCommand(id)
      if (agentIdRef.current === 'codex' && agentId !== 'codex') agentIdRef.current = undefined
      term.write(`\r\n\x1b[90m[Process exited${typeof code === 'number' ? ` (code ${code})` : ''}]\x1b[0m\r\n`)
      onProcessExitRef.current?.()
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
    let typedCommand = ''
    const learnAgentFromCommand = (command: string): void => {
      if (agentIdentityLockedRef.current) return
      const detected = attachmentAgent(command)
      if (!detected) return
      agentIdRef.current = detected
      agentIdentityLockedRef.current = true
    }
    term.onData((data) => {
      // Replayed device queries must not send historical replies to a live shell.
      if (restoreInFlight) return
      if (data === '\r' || data === '\n') {
        learnAgentFromCommand(typedCommand)
        typedCommand = ''
      } else if (data === '\x7f' || data === '\b') {
        typedCommand = typedCommand.slice(0, -1)
      } else if (data === '\x15' || data === '\x03') {
        typedCommand = ''
      } else if (!data.includes('\x1b')) {
        typedCommand = `${typedCommand}${data}`.slice(-128)
      }
      writePty(data)
    })
    term.onResize(({ cols, rows }) => queueResize(cols, rows))

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
          report: (message) => term.write(`\r\n\x1b[31m[${message.replace(/[\x00-\x1f\x7f]/g, ' ')}]\x1b[0m\r\n`),
          alive: () => mounted
        })
      }).catch((error) => {
        console.error('Attachment failed', error)
      })
      return attachmentQueue
    }


    const writeImagePath = (image: { path: string } | null, addTrailingSpace = false): void => {
      if (!image) return void term.write('\r\n\x1b[33m[No image in clipboard]\x1b[0m\r\n')

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
          term.write(`\r\n\x1b[31m[${staged.error}]\x1b[0m\r\n`)
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
          term.write(`\r\n\x1b[31m[${err instanceof Error ? err.message : 'Failed to paste'}]\x1b[0m\r\n`)
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
        term.write(APP_OWNED_MODE_RESET)
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







    void window.api.terminal.create(id, term.cols, term.rows).then((result) => {




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
        term.write(`\r\n\x1b[31m[Failed to launch terminal${err ? `: ${err}` : ''}]\x1b[0m\r\n`)


        if (mounted) setConnecting(false)
        return
      }
      let viewportRestoredAfterWrite = false
      const launchQueuedCommand = (): void => {
        const queued = peekInitialCommand(id)
        if (!mounted || exitReported || !queued) return
        learnAgentFromCommand(queued)
        void window.api.terminal.write(id, `${queued}${cachedSubmit}`).then((result) => {
          if ('error' in result) {
            if (mounted) term.write(`\r\n\x1b[31m[Failed to start command: ${result.error}]\x1b[0m\r\n`)
            return
          }
          markInitialCommandDelivered(id)
        }).catch(() => {
          if (mounted) term.write('\r\n\x1b[31m[Failed to start command]\x1b[0m\r\n')
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
        // terminal has been corrupted. A live re-attach is left alone: there
        // the modes belong to a process that really is still running.
        const marker = result.live
          ? ''
          : `${APP_OWNED_MODE_RESET}\r\n\x1b[90m[Session restored — new process started]\x1b[0m\r\n`
        writePaced(`\x1b[0m${result.scrollback}${marker}`, () => {
          restoreViewportAfterLayout()
          launchQueuedCommand()
        })
        viewportRestoredAfterWrite = true
      }

      if (result.live && container.clientWidth > 0 && container.clientHeight > 0) {
        try {
          const anchor = captureViewportAnchor()
          fit.fit()
          scheduleResizeAnchorRestore(anchor)
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
      flushChannel.port1.close()
      flushChannel.port2.close()
      cancelRestore?.()
      renderQueue.dispose()
      pendingResize = null
      if (resizeSendRaf !== null) {
        cancelAnimationFrame(resizeSendRaf)
        resizeSendRaf = null
      }
      if (resizeSendTimer !== null) {
        clearTimeout(resizeSendTimer)
        resizeSendTimer = null
      }
      if (resizeRaf !== null) cancelAnimationFrame(resizeRaf)
      resizeAnchorGeneration++
      if (resizeRestoreTimer) clearTimeout(resizeRestoreTimer)
      observer.disconnect()
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
  }, [id, surface])

  return (
    <div
      ref={containerRef}
      className={`term-shell term relative h-full w-full focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/60 ${
        surface === 'canvas' ? 'is-canvas-term p-0' : 'is-code-term px-1.5 py-0.5'
      }`}
      data-testid="terminal-xterm"
    >
      {connecting && (
        <div role="status" className="pointer-events-none absolute inset-0 grid place-items-center">
          <span className="animate-pulse rounded-panel bg-bg-raise px-2.5 py-1 text-[11px] text-text-faint">
            Connecting…
          </span>
        </div>
      )}
    </div>
  )
}

export default React.memo(TerminalWidget)
