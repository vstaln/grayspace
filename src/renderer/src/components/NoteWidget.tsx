import React, { useEffect, useRef, useState, useCallback } from 'react'
import { sanitizeUrl, isSafeUrl } from '../lib/sanitizeUrl'
import { renderMarkdownSafe } from '../lib/markdown'

interface NoteWidgetProps {
  widgetId: string
  initialTitle?: string
  initialContent?: string
}

const STORAGE_PREFIX = 'orcspace-note:'

function readNote(widgetId: string): { title: string; content: string } {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${widgetId}`)
    if (!raw) return { title: '', content: '' }
    const parsed = JSON.parse(raw)
    return {
      title: typeof parsed.title === 'string' ? parsed.title : '',
      content: typeof parsed.content === 'string' ? parsed.content : ''
    }
  } catch {
    return { title: '', content: '' }
  }
}

/**
 * Auto-resize hook: grows textarea with content up to maxHeight, then scrolls.
 * Fixes previous bug where note content overflowed or was clipped and required
 * manual scrolling of parent instead of the field itself.
 */
function useAutoResize(ref: React.RefObject<HTMLTextAreaElement | null>, value: string, maxHeight = 480): void {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    // Reset to auto to shrink when content deleted
    el.style.height = 'auto'
    const next = Math.min(el.scrollHeight, maxHeight)
    el.style.height = `${next}px`
    // When capped, enable internal scrolling; otherwise hide scrollbar for clean auto-grow
    el.style.overflowY = el.scrollHeight > maxHeight ? 'auto' : 'hidden'
  }, [ref, value, maxHeight])
}

/**
 * Markdown bold/italic/link shortcuts for textarea.
 * Ctrl+B -> **selection**, Ctrl+I -> *selection*, Ctrl+K -> [selection](url)
 */
function useMarkdownShortcuts(
  ref: React.RefObject<HTMLTextAreaElement | null>,
  content: string,
  setContent: (v: string) => void
): (e: React.KeyboardEvent<HTMLTextAreaElement>) => void {
  return useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      const isMod = e.ctrlKey || e.metaKey
      if (!isMod) return
      const key = e.key.toLowerCase()
      if (key !== 'b' && key !== 'i' && key !== 'k') return
      const el = ref.current
      if (!el) return
      e.preventDefault()
      const start = el.selectionStart
      const end = el.selectionEnd
      const selected = content.slice(start, end)
      let insert = ''
      let caretOffset = 0
      let linkUrl: string | null = null
      if (key === 'b') {
        // Ctrl+B: bold -> **text** or **|**
        if (selected) {
          insert = `**${selected}**`
          caretOffset = insert.length
        } else {
          insert = `****`
          caretOffset = 2
        }
      } else if (key === 'i') {
        if (selected) {
          insert = `*${selected}*`
          caretOffset = insert.length
        } else {
          insert = `**`
          caretOffset = 1
        }
      } else if (key === 'k') {
        // Ctrl+K: link -> [text](url) ; prompt for URL if no selection?
        const url = window.prompt('Enter URL:', 'https://')?.trim() ?? ''
        if (!url) return
        // Sanitize URL immediately – block javascript: etc.
        if (!isSafeUrl(url) || !sanitizeUrl(url)) {
          window.alert('Blocked: unsafe URL (javascript:, data: etc. not allowed)')
          return
        }
        linkUrl = url
        const text = selected || 'link'
        insert = `[${text}](${url})`
        caretOffset = insert.length
      }
      const next = content.slice(0, start) + insert + content.slice(end)
      setContent(next)
      // Restore caret after React re-render
      requestAnimationFrame(() => {
        if (!el) return
        if (selected) {
          // Select the inserted content for easy replacement
          if (key === 'k' && linkUrl) {
            const linkTextEnd = start + 1 + (selected || 'link').length
            el.setSelectionRange(start, linkTextEnd + linkUrl.length + 3)
          } else {
            el.setSelectionRange(start, start + insert.length)
          }
        } else {
          const pos = start + caretOffset
          el.setSelectionRange(pos, pos)
        }
      })
    },
    [ref, content, setContent]
  )
}

export default function NoteWidget({ widgetId, initialTitle = '', initialContent = '' }: NoteWidgetProps): React.JSX.Element {
  const stored = readNote(widgetId)
  const [title, setTitle] = useState(stored.title || initialTitle)
  const [content, setContent] = useState(stored.content || initialContent)
  const [isPreview, setIsPreview] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleRef = useRef<HTMLInputElement>(null)
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLDivElement>(null)

  useAutoResize(areaRef, content)
  const onKeyDown = useMarkdownShortcuts(areaRef, content, setContent)

  // Persist to localStorage debounced
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(`${STORAGE_PREFIX}${widgetId}`, JSON.stringify({ title, content }))
      } catch {
        // quota exceeded – surface but keep editing
        setError('Storage full – note not saved locally')
      }
    }, 400)
    return () => clearTimeout(t)
  }, [widgetId, title, content])

  // Scroll handling: ensure textarea scroll is contained, parent does not double-scroll.
  // The outer container is flex column with min-h-0; textarea is auto-resized up to maxHeight
  // then internal scroll takes over. Preview pane is overflow-auto as well.
  const sanitizedPreview = isPreview ? renderMarkdownSafe(content) : ''

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    // Allow default paste; sanitization happens at render time.
    // Block pasted javascript: URLs from becoming active links without user interaction
    // by not auto-linkifying – our renderer will sanitize.
    void e
  }

  // Verify shortcuts hint
  const shortcutHint = `${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+B Bold, ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+I Italic, ${navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}+K Link`

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="note-widget">
      <div className="flex items-center gap-2">
        <input
          ref={titleRef}
          className="min-w-0 flex-1 rounded-[8px] border border-line bg-bg-raise/40 px-2.5 py-1.5 text-[13px] font-semibold text-text outline-none placeholder:text-text-faint focus:border-accent"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Note title…"
          aria-label="Note title"
        />
        <button
          type="button"
          className={`rounded-[8px] px-2.5 py-1 text-[11px] ${isPreview ? 'bg-accent text-bg' : 'border border-line text-text-dim hover:bg-bg-hover'}`}
          onClick={() => setIsPreview((v) => !v)}
          aria-pressed={isPreview}
          title={isPreview ? 'Edit' : 'Preview'}
        >
          {isPreview ? 'Edit' : 'Preview'}
        </button>
      </div>

      {error && (
        <div className="rounded-[8px] border border-danger/30 bg-danger/10 px-2 py-1 text-[11px] text-danger" role="alert">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col">
        {isPreview ? (
          <div
            ref={previewRef}
            className="prose prose-invert min-h-0 flex-1 overflow-auto rounded-[8px] border border-line-soft bg-bg-hover/20 p-3 text-[13px] leading-relaxed text-text"
            // Rendered HTML is sanitized by renderMarkdownSafe – it escapes and blocks javascript: etc.
            dangerouslySetInnerHTML={{ __html: sanitizedPreview || '<span class="text-text-faint">Nothing to preview</span>' }}
            onClick={(e) => {
              const target = e.target as HTMLElement
              const anchor = target.closest('a')
              if (anchor) {
                const href = anchor.getAttribute('href') ?? ''
                if (!isSafeUrl(href)) {
                  e.preventDefault()
                  setError('Blocked unsafe link')
                }
              }
            }}
          />
        ) : (
          <textarea
            ref={areaRef}
            className="min-h-[120px] w-full flex-1 resize-none rounded-[8px] border border-line bg-bg-raise/40 p-2.5 text-[13px] leading-relaxed text-text outline-none placeholder:text-text-faint focus:border-accent"
            style={{ maxHeight: 480 }}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={handlePaste}
            placeholder={`Write markdown… Paste images or use ${shortcutHint}`}
            aria-label="Note content"
            rows={6}
          />
        )}
        {!isPreview && (
          <div className="mt-1.5 text-[10px] text-text-faint" title={shortcutHint}>
            Tips: {shortcutHint} · URLs like javascript: are blocked automatically
          </div>
        )}
      </div>
    </div>
  )
}
