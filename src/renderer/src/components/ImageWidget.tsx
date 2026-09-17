import React, { useEffect, useMemo, useState } from 'react'
import { Check, Copy, ExternalLink, Image as ImageIcon } from 'lucide-react'
import { copyText } from '../lib/clipboard'

interface Props {
  path?: string
  name?: string
}

export default React.memo(function ImageWidget({ path, name }: Props): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const [copied, setCopied] = useState(false)
  const [dataUrl, setDataUrl] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setFailed(false)
    setDataUrl(null)
    if (!path) return () => { alive = false }
    void window.api.media.dataUrl(path).then((url) => {
      if (alive) setDataUrl(url)
    }).catch(() => {})
    return () => { alive = false }
  }, [path])

  const mediaUrl = useMemo(() => {
    if (!name || !/^[A-Za-z0-9_-]{1,128}\.[A-Za-z0-9_-]{1,16}$/.test(name)) return null
    return `orc://media/${encodeURIComponent(name)}`
  }, [name])
  const source = dataUrl || mediaUrl

  const copyPath = (): void => {
    if (!path) return
    void copyText(path).then((ok) => {
      if (!ok) return
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1200)
    })
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg p-2">
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-panel border border-line-soft bg-black/20">
        {source && !failed ? (
          <img
            src={source}
            alt={name || 'Pinned image'}
            className="max-h-full max-w-full object-contain"
            onError={() => setFailed(true)}
          />
        ) : (
          <div role="status" className="flex max-w-[90%] flex-col items-center gap-2 text-center text-[11px] text-text-faint">
            <ImageIcon size={28} strokeWidth={1.4} />
            <span>{path ? 'Image could not be loaded' : 'No image attached'}</span>
            {path && <code className="max-w-full truncate text-[10px] text-text-faint" title={path}>{path}</code>}
          </div>
        )}
      </div>
      <div className="flex min-w-0 items-center gap-2 px-1 pt-2">
        <span className="min-w-0 flex-1 truncate text-[10px] text-text-faint" title={path}>{name || path || 'Clipboard image'}</span>
        {path && (
          <>
            <button type="button" className="grid h-6 w-6 flex-none place-items-center rounded-pill text-text-faint hover:bg-bg-hover hover:text-text" onClick={copyPath} title="Copy image path" aria-label="Copy image path">
              {copied ? <Check size={12} /> : <Copy size={12} />}
            </button>
            <button type="button" className="grid h-6 w-6 flex-none place-items-center rounded-pill text-text-faint hover:bg-bg-hover hover:text-text" onClick={() => void window.api.fs.openPath(path)} title="Open image externally" aria-label="Open image externally">
              <ExternalLink size={12} />
            </button>
          </>
        )}
      </div>
    </div>
  )
})
