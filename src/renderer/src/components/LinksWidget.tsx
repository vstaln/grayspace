import React, { useEffect, useRef, useState } from 'react'
import { Check, Clipboard, Link2, Plus, Trash2 } from 'lucide-react'
import { isSafeUrl, safeHref, withScheme } from '../lib/sanitizeUrl'

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
    if (!Array.isArray(parsed)) return []
    return parsed.slice(0, 200).filter(
      (item): item is LinkItem =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof item.id === 'string' &&
        typeof item.title === 'string' &&
        typeof item.url === 'string' &&


        isSafeUrl(item.url)
    )
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


  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aliveRef = useRef(true)

  useEffect(() => {
    try {
      localStorage.setItem(`${STORAGE_PREFIX}${widgetId}`, JSON.stringify(links))
    } catch {

    }
  }, [links, widgetId])







  useEffect(() => {
    aliveRef.current = true
    return () => {
      aliveRef.current = false
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
    }
  }, [])

  const addLink = (event: React.FormEvent): void => {
    event.preventDefault()
    const value = withScheme(url.trim())
    const cleanTitle = title.trim()
    if (!value) {
      setError('Enter a link')
      return
    }

    if (!isSafeUrl(value)) {
      setError('Blocked: unsafe URL (javascript:, data: etc. not allowed)')
      return
    }
    if (links.some((item) => item.url.trim() === value)) {
      setError('Link already added')
      return
    }
    let defaultTitle = value
    try {
      defaultTitle = new URL(value).hostname || value
    } catch {

    }
    setLinks((current) => [
      ...current,
      { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, title: cleanTitle || defaultTitle, url: value }
    ])
    setTitle('')
    setUrl('')
    setError(null)
  }

  const copyLink = async (link: LinkItem): Promise<void> => {
    try {
      await navigator.clipboard.writeText(link.url)
      if (!aliveRef.current) return
      setCopiedId(link.id)
      if (copiedTimerRef.current !== null) clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = setTimeout(
        () => setCopiedId((current) => (current === link.id ? null : current)),
        1400
      )
    } catch {
      if (aliveRef.current) setError('Failed to copy link')
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2.5 p-3" data-testid="links-widget">
      <form className="space-y-1.5" onSubmit={addLink}>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-panel border border-line bg-bg-raise px-2.5 py-1.5 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Link name (optional)"
            aria-label="Link title"
            maxLength={200}
          />
        </div>
        <div className="flex gap-1.5">
          <input
            className="min-w-0 flex-1 rounded-panel border border-line bg-bg-raise px-2.5 py-1.5 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-accent"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value)
              // Otherwise the rejection stays on screen while the user is
              // already typing the corrected link.
              setError(null)
            }}
            placeholder="URL or path"
            aria-label="URL"
            maxLength={2000}
          />
          <button className="grid h-8 w-8 flex-none place-items-center rounded-pill bg-accent text-bg hover:brightness-110" title="Add link" aria-label="Add link" type="submit">
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
        ) : links.map((link) => {
          const href = safeHref(link.url)
          return (
          <div key={link.id} className="group flex items-center gap-2 rounded-panel border border-line-soft bg-bg-raise px-2 py-1.5">
            <Link2 className="flex-none text-accent" size={14} />
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="min-w-0 flex-1 cursor-pointer block hover:opacity-80 transition-opacity"
                aria-label={`Open ${link.title}`}
              >
                <div className="truncate text-[11px] text-text hover:text-accent" title={link.title}>{link.title}</div>
                <div className="truncate text-[10px] text-text-faint" title={link.url}>{displayUrl(link.url)}</div>
              </a>
            ) : (
              <div
                className="min-w-0 flex-1 cursor-default block"
                title="Cannot open this path in browser"
                aria-label={link.title}
              >
                <div className="truncate text-[11px] text-text" title={link.title}>{link.title}</div>
                <div className="truncate text-[10px] text-text-faint" title={link.url}>{displayUrl(link.url)}</div>
              </div>
            )}
            <button className="grid h-7 w-7 flex-none place-items-center rounded-pill text-text-faint hover:bg-bg-hover hover:text-accent" onClick={() => void copyLink(link)} title={href ? 'Copy link' : 'Copy path'} aria-label={href ? `Copy ${link.title}` : `Copy path ${link.title}`}>
              {copiedId === link.id ? <Check size={14} /> : <Clipboard size={14} />}
            </button>
            <button className="grid h-7 w-7 flex-none place-items-center rounded-pill text-text-faint hover:bg-danger/15 hover:text-danger" onClick={() => setLinks((current) => current.filter((item) => item.id !== link.id))} title="Remove link" aria-label={`Remove ${link.title}`}>
              <Trash2 size={13} />
            </button>
          </div>
          )
        })}
      </div>
    </div>
  )
}
