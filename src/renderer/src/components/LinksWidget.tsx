import React, { useEffect, useRef, useState } from 'react'
import { Check, Clipboard, Link2, Plus, Trash2 } from 'lucide-react'

interface LinkItem {
  id: string
  title: string
  url: string
}

const STORAGE_PREFIX = 'orcspace-links:'

function readLinks(widgetId: string): LinkItem[] {
  try {
    const raw = localStorage.getItem(`${STORAGE_PREFIX}${widgetId}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function displayUrl(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname === '/' ? '' : parsed.pathname}`
  } catch {
    return url
  }
}

export default function LinksWidget({ widgetId }: { widgetId: string }): React.JSX.Element {
  const [links, setLinks] = useState<LinkItem[]>(() => readLinks(widgetId))
  const [title, setTitle] = useState('')
  const [url, setUrl] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  // Cleared on unmount so a closed widget cannot flip state later; without it
  // every "copied" flash schedules one more post-unmount setState.
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    localStorage.setItem(`${STORAGE_PREFIX}${widgetId}`, JSON.stringify(links))
  }, [links, widgetId])

  // Only the timer is cleaned up here. Purging this widget's saved links used
  // to happen on unmount too, on the assumption that an unmount always meant
  // "closed for good" — it did not, and the widget lost every link the moment
  // the user maximized it (see WIDGET-maximize in App.tsx). The purge now
  // lives in `useCanvas.removeWidget`, which is the one place that actually
  // knows a widget was closed rather than re-parented.
  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const addLink = (event: React.FormEvent): void => {
    event.preventDefault()
    const value = url.trim()
    if (!value) {
      setError('Enter a link')
      return
    }
    let defaultTitle = value
    try {
      defaultTitle = new URL(value).hostname || value
    } catch {
      // Non-HTTP values are valid too: local paths, localhost and deep links.
    }
    setLinks((current) => [
      ...current,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title: title.trim() || defaultTitle, url: value }
    ])
    setTitle('')
    setUrl('')
    setError(null)
  }

  const copyLink = async (link: LinkItem): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link.url)
      setCopiedId(link.id)
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(
        () => setCopiedId((current) => (current === link.id ? null : current)),
        1400
      )
    } catch {
      setError('Failed to copy link')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3" data-testid="links-widget">
      <form className="space-y-1.5" onSubmit={addLink}>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-[8px] border border-line bg-bg-raise/40 px-2.5 py-1.5 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Link name (optional)"
            aria-label="Link title"
          />
        </div>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-[8px] border border-line bg-bg-raise/40 px-2.5 py-1.5 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="URL or path"
            aria-label="URL"
          />
          <button className="grid h-8 w-8 flex-none place-items-center rounded-[8px] bg-accent text-bg hover:brightness-110" title="Add link" aria-label="Add link" type="submit">
            <Plus size={15} />
          </button>
        </div>
      </form>
      {error && <div className="text-[10px] text-danger" role="alert">{error}</div>}
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-0.5">
        {links.length === 0 ? (
          <div className="grid h-full place-items-center px-4 text-center text-[11px] text-text-faint">
            <div><Link2 className="mx-auto mb-2 opacity-50" size={22} /><div>Add your first link</div></div>
          </div>
        ) : links.map((link) => (
          <div key={link.id} className="group flex items-center gap-2 rounded-[9px] border border-line-soft bg-bg-raise/20 px-2 py-1.5">
            <Link2 className="flex-none text-accent" size={14} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[11px] text-text" title={link.title}>{link.title}</div>
              <div className="truncate text-[10px] text-text-faint" title={link.url}>{displayUrl(link.url)}</div>
            </div>
            <button className="grid h-7 w-7 flex-none place-items-center rounded-[7px] text-text-faint hover:bg-bg-hover hover:text-accent" onClick={() => void copyLink(link)} title="Copy link" aria-label={`Copy ${link.title}`}>
              {copiedId === link.id ? <Check size={14} /> : <Clipboard size={14} />}
            </button>
            <button className="grid h-7 w-7 flex-none place-items-center rounded-[7px] text-text-faint hover:bg-danger/15 hover:text-danger" onClick={() => setLinks((current) => current.filter((item) => item.id !== link.id))} title="Remove link" aria-label={`Remove ${link.title}`}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
