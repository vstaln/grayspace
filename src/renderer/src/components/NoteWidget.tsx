import React, { useEffect, useRef, useState } from 'react'
import { FileText, Tag } from 'lucide-react'
import type { BrainNote } from '../../../preload/index.d'
import NoteAttachments from './NoteAttachments'
import { insertAt, pasteHasImage, saveImageFromPaste } from '../lib/paste'

/**
 * Quick-capture note on the canvas. Edits stay local and flush on a debounce,
 * so typing never waits on the write to disk.
 */
export default function NoteWidget({ noteId }: { noteId: string; workspaceDir?: string | null }): React.JSX.Element {
  const [note, setNote] = useState<BrainNote | null>(null)
  const [state, setState] = useState<'saved' | 'saving' | 'dirty' | 'error'>('saved')
  const latest = useRef<BrainNote | null>(null)
  latest.current = note

  useEffect(() => {
    void window.api.brain.list().then(({ notes }) => setNote(notes.find((x) => x.id === noteId) || null))
  }, [noteId])

  const patch = (changes: Partial<BrainNote>): void => {
    setNote((current) => (current ? { ...current, ...changes } : current))
    setState('dirty')
  }

  useEffect(() => {
    if (state !== 'dirty' || !latest.current) return
    const snapshot = latest.current
    const timer = setTimeout(async () => {
      setState('saving')
      try {
        await window.api.brain.update(snapshot.id, {
          title: snapshot.title,
          content: snapshot.content,
          tags: snapshot.tags
        })
        setState((current) => (current === 'saving' ? 'saved' : current))
      } catch {
        // Keep the text in the editor; the next keystroke retries (P2-218).
        setState('error')
      }
    }, 450)
    return () => clearTimeout(timer)
  }, [state, note?.title, note?.content, note?.tags])

  // Whether the last keystroke is still unpersisted; read at unmount time so a
  // close before the debounce fires cannot drop the final edit (DI-003).
  const dirtyRef = useRef(false)
  useEffect(() => {
    dirtyRef.current = state === 'dirty'
  }, [state])
  useEffect(() => {
    return () => {
      const pending = latest.current
      if (dirtyRef.current && pending) {
        void window.api.brain.update(pending.id, {
          title: pending.title,
          content: pending.content,
          tags: pending.tags
        })
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
  }

  if (!note) return <div className="grid h-full place-items-center text-[13px] text-text-faint">Заметка не найдена</div>

  const statusColor = state === 'saved' ? 'bg-ok' : state === 'error' ? 'bg-danger' : 'bg-[#f59e0b]'
  const statusTitle = state === 'saved' ? 'Сохранено' : state === 'error' ? 'Ошибка сохранения' : 'Сохранение...'

  return (
    <div className="flex h-full flex-col gap-3 bg-[rgba(18,18,20,0.6)] backdrop-blur-[28px] p-4 rounded-[10px]">
      <div className="flex items-center gap-3">
        <input
          className="flex-1 border-0 bg-transparent py-1 text-[22px] font-bold text-text outline-none placeholder:text-text-dim"
          value={note.title}
          onChange={(e) => patch({ title: e.target.value })}
          placeholder="Название заметки"
        />
        <div 
          className={`h-2 w-2 rounded-full flex-none transition-colors duration-300 ${statusColor}`}
          title={statusTitle}
          role="status"
        />
      </div>

      <textarea
        className="min-h-0 flex-1 resize-none rounded-[10px] border border-transparent bg-transparent p-2 -mx-2 text-[13px] leading-relaxed text-text outline-none focus:border-line-soft transition-colors duration-200 placeholder:text-text-faint"
        value={note.content}
        onChange={(e) => patch({ content: e.target.value })}
        onPaste={(e) => void onPaste(e)}
        placeholder="Запишите мысль… Ctrl+V вставляет картинку."
      />
      
      <NoteAttachments content={note.content} />
      
      <div className="flex flex-wrap items-center gap-1.5 pt-2">
        <Tag size={13} className="text-text-faint mr-1" />
        {note.tags.map((tag, i) => (
          <span key={i} className="rounded-full bg-white/[0.06] px-2 py-0.5 text-[11px] text-text-dim border border-line-soft">
            {tag}
          </span>
        ))}
        <input
          className="flex-1 min-w-[120px] border-0 bg-transparent text-[11px] text-text-dim outline-none placeholder:text-text-faint"
          placeholder={note.tags.length ? "+ тег (через запятую)" : "теги через запятую"}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault()
              const newTag = e.currentTarget.value.trim().replace(/^,|,$/g, '')
              if (newTag && !note.tags.includes(newTag)) {
                patch({ tags: [...note.tags, newTag] })
              }
              e.currentTarget.value = ''
            }
            if (e.key === 'Backspace' && e.currentTarget.value === '' && note.tags.length > 0) {
              patch({ tags: note.tags.slice(0, -1) })
            }
          }}
        />
      </div>
    </div>
  )
}
