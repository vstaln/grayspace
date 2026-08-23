import React, { useEffect, useRef, useState } from 'react'
import { Tag } from 'lucide-react'
import type { BrainNote } from '../../../preload/index.d'
import NoteAttachments from './NoteAttachments'
import { insertAt, pasteHasImage, saveImageFromPaste } from '../lib/paste'
import { frost, lanes, palette } from '../design'

/**
 * Quick-capture note on the canvas. Edits stay local and flush on a debounce,
 * so typing never waits on the write to disk.
 */
export default function NoteWidget({
  noteId,
  onTitle
}: {
  noteId: string
  workspaceDir?: string | null
  onTitle?(title: string): void
}): React.JSX.Element {
  const [note, setNote] = useState<BrainNote | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [state, setState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const latest = useRef<BrainNote | null>(null)
  latest.current = note
  const dirtyRef = useRef(false)
  // The widget-frame title follows the note title, but propagating it on every
  // keystroke re-rendered the whole memoized frame and dirtied the canvas
  // (→ debounced save churn) for each character typed. Coalesce instead: the
  // frame title catches up after a short pause, or right away when the field
  // is left (NOTE-01).
  const titleSyncTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onTitleRef = useRef(onTitle)
  onTitleRef.current = onTitle
  const syncTitle = (title: string): void => {
    if (!onTitle) return
    if (titleSyncTimer.current !== null) clearTimeout(titleSyncTimer.current)
    titleSyncTimer.current = setTimeout(() => {
      titleSyncTimer.current = null
      // The frame header has no placeholder of its own — an emptied note title
      // must not leave it blank.
      onTitleRef.current?.(title.trim() || 'Untitled')
    }, 500)
  }
  const flushTitle = (): void => {
    if (titleSyncTimer.current !== null) {
      clearTimeout(titleSyncTimer.current)
      titleSyncTimer.current = null
    }
    if (onTitle && latest.current) onTitle(latest.current.title.trim() || 'Untitled')
  }
  useEffect(() => {
    return () => {
      if (titleSyncTimer.current !== null) clearTimeout(titleSyncTimer.current)
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoaded(false)
    // `get` instead of `list`: a note widget needs one record, not every full
    // content in the store serialized over IPC on each mount/retry.
    window.api.brain
      .get(noteId)
      .then((found) => {
        if (!cancelled) setNote(found ?? null)
      })
      .catch(() => {
        if (!cancelled) setNote(null)
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [noteId])

  useEffect(() => {
    return window.api.brain.onChange(({ notes }) => {
      if (dirtyRef.current) return
      const next = notes.find((x) => x.id === noteId) || null
      setNote(next)
      setLoaded(true)
    })
  }, [noteId])

  const patch = (changes: Partial<BrainNote>): void => {
    dirtyRef.current = true
    setNote((current) => (current ? { ...current, ...changes } : current))
    setState('dirty')
  }

  useEffect(() => {
    if (state !== 'dirty' || !latest.current) return
    const timer = setTimeout(async () => {
      // Snapshot at fire time, not schedule time: a save that completes while
      // this timer is pending merges a bumped version into `latest.current`, and
      // a snapshot captured earlier would carry a baseVersion the disk already
      // superseded (update rejected → edits stuck unsaved until the next key).
      const snapshot = latest.current
      if (!snapshot) return
      setState('saving')
      try {
        const result = await window.api.brain.update(snapshot.id, {
          title: snapshot.title,
          content: snapshot.content,
          tags: snapshot.tags,
          baseVersion: snapshot.version
        })
        // Bus failures return `{ error }` rather than throwing.
        if (!result || 'error' in result) {
          setState('error')
          return
        }
        setNote((current) =>
          current && current.id === result.id
            ? { ...current, version: result.version, updatedAt: result.updatedAt }
            : current
        )
        setState((current) => (current === 'saving' ? 'saved' : current))
      } catch {
        // Keep the text in the editor; the next keystroke retries (P2-218).
        setState('error')
      }
    }, 450)
    return () => clearTimeout(timer)
    // `version` is deliberately not a dep: a successful save merges a bumped
    // version into the note, and re-running the effect then would clear the
    // timer scheduled for keystrokes typed while that save was in flight.
  }, [state, note?.title, note?.content, note?.tags])

  // Whether the last keystroke is still unpersisted; read at unmount time so a
  // close before the debounce fires cannot drop the final edit (DI-003).
  // `error` keeps the guard armed: a failed save means the editor holds text
  // main does not, so broadcasts must stay ignored and the unmount flush must
  // retry — clearing the flag on error silently lost that last edit (P2-218).
  useEffect(() => {
    dirtyRef.current = state === 'dirty' || state === 'error'
  }, [state])
  useEffect(() => {
    return () => {
      const pending = latest.current
      if (dirtyRef.current && pending) {
        void window.api.brain.update(pending.id, {
          title: pending.title,
          content: pending.content,
          tags: pending.tags,
          baseVersion: pending.version
        }).catch(() => {})
      }
    }
  }, [])

  /**
   * A picture is stored on disk and linked from the body; only a real image
   * paste is intercepted, so pasting text keeps the browser's own behaviour.
   */
  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>): Promise<void> => {
    if (!pasteHasImage(e.nativeEvent)) return
    e.preventDefault()
    const area = e.currentTarget
    const { selectionStart, selectionEnd, value } = area
    try {
      const saved = await saveImageFromPaste(e.nativeEvent)
      if (!saved) return
      const { value: next, caret } = insertAt(
        value,
        selectionStart,
        selectionEnd,
        `\n![${saved.name}](${saved.path})\n`
      )
      patch({ content: next })
      requestAnimationFrame(() => area.setSelectionRange(caret, caret))
    } catch {
      return
    }
  }

  if (!loaded) {
    return (
      <div className="grid h-full place-items-center text-[13px] text-text-faint" role="status">
        Loading…
      </div>
    )
  }
  if (!note) {
    return (
      <div className="grid h-full place-items-center gap-2 px-4 text-center text-[13px] text-text-faint">
        <span>Note not found — it may have been deleted.</span>
        <button
          type="button"
          className="rounded-[8px] border border-line px-2.5 py-1 text-[11px] text-text-dim hover:bg-bg-hover hover:text-text"
          onClick={() => {
            setLoaded(false)
            window.api.brain
              .get(noteId)
              .then((found) => setNote(found ?? null))
              .catch(() => setNote(null))
              .finally(() => setLoaded(true))
          }}
        >
          Retry
        </button>
      </div>
    )
  }

  const statusTitle =
    state === 'saved' ? 'Saved' : state === 'error' ? 'Save error' : state === 'dirty' ? 'Unsaved changes' : 'Saving…'
  // Amber matches lanes.amber.dot (warning / in-flight), not a one-off hex.
  const statusStyle =
    state === 'saved'
      ? undefined
      : state === 'error'
        ? undefined
        : { backgroundColor: lanes.amber.dot }

  return (
    <div
      className="note-surface flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-[10px] p-4"
      style={{ background: palette.graphite, backdropFilter: frost.shell, WebkitBackdropFilter: frost.shell }}
    >
      <div className="flex min-w-0 items-center gap-3">
        <input
          className={`min-w-0 flex-1 border-0 bg-transparent py-1 text-[22px] font-bold outline-none transition-colors duration-200 ${
            note.title.trim() && note.title !== 'New Note' ? 'text-text-dim' : 'text-text-faint'
          }`}
          value={note.title}
          onChange={(e) => {
            const title = e.target.value
            patch({ title })
            syncTitle(title)
          }}
          onBlur={flushTitle}
          placeholder="Note title…"
          aria-label="Note title"
        />
        <div
          className={`h-2 w-2 flex-none rounded-full transition-colors duration-300 ${
            state === 'saved' ? 'bg-ok' : state === 'error' ? 'bg-danger' : ''
          }`}
          style={statusStyle}
          title={statusTitle}
          role="status"
          aria-label={statusTitle}
        />
      </div>

      <textarea
        className="min-h-0 flex-1 resize-none rounded-[10px] border border-transparent bg-transparent p-2 -mx-2 text-[13px] leading-relaxed text-text outline-none transition-colors duration-200 placeholder:text-text-faint focus:border-line-soft"
        value={note.content}
        onChange={(e) => patch({ content: e.target.value })}
        onPaste={(e) => void onPaste(e)}
        placeholder="Write your note… Paste images directly with Ctrl+V."
        aria-label="Note content"
      />

      <NoteAttachments content={note.content} />

      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        <Tag size={13} className="mr-1 flex-none text-text-faint" aria-hidden />
        {(note.tags || []).map((tag, i) => (
          <span
            key={i}
            className="max-w-full truncate rounded-full border border-line-soft bg-bg-hover px-2 py-0.5 text-[11px] text-text-dim"
            title={tag}
          >
            {tag}
          </span>
        ))}
        <input
          className="min-w-[120px] flex-1 border-0 bg-transparent text-[11px] text-text-dim outline-none placeholder:text-text-faint"
          placeholder={(note.tags || []).length ? '+ tag (comma separated)' : 'tags (comma separated)'}
          aria-label="Add tag"
          onKeyDown={(e) => {
            const currentTags = note.tags || []
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              const newTag = e.currentTarget.value.trim().replace(/^,|,$/g, '')
              if (newTag && !currentTags.includes(newTag)) {
                patch({ tags: [...currentTags, newTag] })
              }
              e.currentTarget.value = ''
            }
            if (e.key === 'Backspace' && e.currentTarget.value === '' && currentTags.length > 0) {
              patch({ tags: currentTags.slice(0, -1) })
            }
          }}
        />
      </div>
    </div>
  )
}
