import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowLeft,
  ChevronRight,
  Copy,
  ExternalLink,
  Eye,
  File,
  FileCode,
  FileImage,
  FileJson,
  FilePlus,
  FileSpreadsheet,
  FileText,
  Film,
  Folder,
  FolderPlus,
  Music,
  Pencil,
  RefreshCw,
  Search,
  Trash2,
  X
} from 'lucide-react'
import type { FileEntry, FileReadResult, FsListResult } from '../../../preload/index.d'
import { useConfirm } from './ConfirmDialog'
import { useFocusTrap } from '../hooks/useFocusTrap'

interface Props {
  workspaceDir?: string | null
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(k)), sizes.length - 1)
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`
}

function isPathInside(path: string, ancestor: string): boolean {
  const a = path.replace(/[\\/]+$/, '').toLowerCase()
  const b = ancestor.replace(/[\\/]+$/, '').toLowerCase()
  return a === b || a.startsWith(`${b}\\`) || a.startsWith(`${b}/`)
}

function joinChildPath(dir: string, name: string): string | null {
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[\\/]/.test(trimmed) || trimmed.includes('..')) {
    return null
  }
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return `${dir.replace(/[\\/]+$/, '')}${sep}${trimmed}`
}

function formatDate(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function getFileIcon(entry: FileEntry): React.JSX.Element {
  if (entry.isDirectory) {
    return <Folder size={14} className="flex-none text-accent" />
  }
  const ext = entry.ext.toLowerCase()
  if (['.ts', '.tsx', '.js', '.jsx', '.py', '.rs', '.go', '.c', '.cpp', '.java', '.php', '.rb', '.sh', '.bat', '.cmd'].includes(ext)) {
    return <FileCode size={14} className="flex-none text-[#7aa2f7]" />
  }
  if (['.json', '.yaml', '.yml', '.toml', '.xml', '.env', '.config'].includes(ext)) {
    return <FileJson size={14} className="flex-none text-[#e6c07b]" />
  }
  if (['.md', '.markdown', '.txt', '.log'].includes(ext)) {
    return <FileText size={14} className="flex-none text-[#7fd99a]" />
  }
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.bmp'].includes(ext)) {
    return <FileImage size={14} className="flex-none text-[#c792ea]" />
  }
  if (['.mp3', '.wav', '.ogg', '.flac', '.m4a'].includes(ext)) {
    return <Music size={14} className="flex-none text-[#f783ac]" />
  }
  if (['.mp4', '.mkv', '.webm', '.avi', '.mov'].includes(ext)) {
    return <Film size={14} className="flex-none text-[#ff6b6b]" />
  }
  if (['.csv', '.xlsx', '.xls'].includes(ext)) {
    return <FileSpreadsheet size={14} className="flex-none text-[#69db7c]" />
  }
  return <File size={14} className="flex-none text-text-faint" />
}

export default React.memo(function FilesWidget({ workspaceDir }: Props): React.JSX.Element {
  const confirm = useConfirm()
  const [currentPath, setCurrentPath] = useState<string | null>(workspaceDir || null)
  const [parentPath, setParentPath] = useState<string | null>(null)
  const [items, setItems] = useState<FileEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [showHidden, setShowHidden] = useState(false)
  const [previewFile, setPreviewFile] = useState<FileReadResult | null>(null)
  const [actionNotice, setActionNotice] = useState<string | null>(null)

  // Creation modals / inputs
  const [creatingType, setCreatingType] = useState<'file' | 'dir' | null>(null)
  const [newItemName, setNewItemName] = useState('')
  const [renamingPath, setRenamingPath] = useState<string | null>(null)
  const [renamingName, setRenamingName] = useState('')
  const renameCancelled = useRef(false)
  const renameInFlightRef = useRef(false)
  const fsActionBusyRef = useRef(false)
  const previewRef = useRef<HTMLDivElement>(null)
  useFocusTrap(previewRef, Boolean(previewFile))

  // Request sequencing: a slower earlier `fs.list`/`fs.readFile` response must
  // not overwrite the result of a newer navigation or preview.
  const dirSeq = useRef(0)
  const previewSeq = useRef(0)

  // Sync on WORKSPACE CHANGE only. Clamping here on every navigation used to
  // fight the user: fs.list is not scoped to the workspace, so stepping above
  // the root (← button / C: crumb) rendered fine and then this effect yanked
  // the view back to the root — a visible bounce plus a second fs:list
  // round-trip. Navigation stays free; only a real workspace switch clamps.
  const lastWorkspaceRef = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    const changed = lastWorkspaceRef.current !== workspaceDir
    lastWorkspaceRef.current = workspaceDir
    if (!changed || !workspaceDir) return
    if (!currentPath || !isPathInside(currentPath, workspaceDir)) {
      setCurrentPath(workspaceDir)
    }
  }, [workspaceDir, currentPath])

  useEffect(() => {
    if (!previewFile) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      e.stopImmediatePropagation()
      setPreviewFile(null)
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [previewFile])

  const loadDir = useCallback(async (dir?: string | null): Promise<void> => {
    const seq = ++dirSeq.current
    setLoading(true)
    setError(null)
    try {
      const res = (await window.api.fs.list(dir || undefined, { showHidden })) as FsListResult | { error: string }
      if (seq !== dirSeq.current) return
      if ('error' in res && res.error) {
        setError(res.error)
        setItems([])
      } else if ('items' in res) {
        setItems(res.items)
        setCurrentPath(res.currentPath)
        setParentPath(res.parentPath)
      }
    } catch (err) {
      if (seq !== dirSeq.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === dirSeq.current) setLoading(false)
    }
  }, [showHidden])

  useEffect(() => {
    void loadDir(currentPath)
  }, [currentPath, showHidden, loadDir])

  const noticeTimer = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const showNotice = (msg: string): void => {
    setActionNotice(msg)
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
    noticeTimer.current = setTimeout(() => setActionNotice(null), 3500)
  }
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current)
  }, [])

  const navigateUp = (): void => {
    if (parentPath) {
      setCurrentPath(parentPath)
    }
  }

  const openItem = (entry: FileEntry): void => {
    if (entry.isDirectory) {
      setCurrentPath(entry.path)
    } else {
      void viewFile(entry.path)
    }
  }

  const viewFile = async (path: string): Promise<void> => {
    const seq = ++previewSeq.current
    try {
      const res = await window.api.fs.readFile(path)
      if (seq !== previewSeq.current) return
      if ('error' in res && res.error) {
        showNotice(`Cannot preview: ${res.error}`)
      } else {
        setPreviewFile(res as FileReadResult)
      }
    } catch (err) {
      if (seq !== previewSeq.current) return
      showNotice(`Failed to open preview: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const handleCreate = async (): Promise<void> => {
    const name = newItemName.trim()
    if (!name || !currentPath || !creatingType || fsActionBusyRef.current) return
    fsActionBusyRef.current = true
    const targetPath = joinChildPath(currentPath, name)
    if (!targetPath) {
      showNotice('Name cannot contain path separators or “..”')
      fsActionBusyRef.current = false
      return
    }
    try {
      if (creatingType === 'file') {
        const res = await window.api.fs.createFile(targetPath)
        if (res.error) showNotice(`Failed to create file: ${res.error}`)
        else {
          showNotice(`Created file "${name}"`)
          setCreatingType(null)
          setNewItemName('')
          void loadDir(currentPath)
        }
      } else {
        const res = await window.api.fs.createDir(targetPath)
        if (res.error) showNotice(`Failed to create folder: ${res.error}`)
        else {
          showNotice(`Created folder "${name}"`)
          setCreatingType(null)
          setNewItemName('')
          void loadDir(currentPath)
        }
      }
    } catch (err) {
      showNotice(String(err))
    } finally {
      fsActionBusyRef.current = false
    }
  }

  /** Enters inline rename mode for an entry (UI-audit: the rename machinery
   *  existed but nothing ever set `renamingPath`, so it was unreachable). */
  const startRename = (entry: FileEntry): void => {
    if (fsActionBusyRef.current) return
    // Clear a flag left armed by an earlier Escape: the input unmounts without
    // blurring, and a stale flag swallowed the next rename's Enter commit.
    renameCancelled.current = false
    setRenamingPath(entry.path)
    setRenamingName(entry.name)
  }

  const handleRename = async (): Promise<void> => {
    // A single keypress on Enter triggers both `onKeyDown` and the subsequent
    // `onBlur` from the unmounting input; without this gate both paths would
    // race to rename the same entry twice (the second hit reading the now
    // cleared `renamingPath` and bailing out — but only after a wasted IPC).
    if (renameInFlightRef.current) return
    if (renameCancelled.current) {
      renameCancelled.current = false
      return
    }
    const name = renamingName.trim()
    if (!name || !renamingPath || !currentPath || fsActionBusyRef.current) return
    renameInFlightRef.current = true
    try {
      const targetPath = joinChildPath(currentPath, name)
      if (!targetPath) {
        showNotice('Name cannot contain path separators or “..”')
        return
      }
      const res = await window.api.fs.rename(renamingPath, targetPath)
      if (res.error) showNotice(`Failed to rename: ${res.error}`)
      else {
        showNotice(`Renamed to "${name}"`)
        setRenamingPath(null)
        setRenamingName('')
        if (previewFile?.path === renamingPath) void viewFile(targetPath)
        void loadDir(currentPath)
      }
    } catch (err) {
      showNotice(String(err))
    } finally {
      fsActionBusyRef.current = false
      renameInFlightRef.current = false
    }
  }

  const handleDelete = async (entry: FileEntry): Promise<void> => {
    const ok = await confirm(`Delete ${entry.isDirectory ? 'folder' : 'file'} "${entry.name}"?`, {
      danger: true,
      title: 'Delete Confirmation',
      confirmLabel: 'Delete'
    })
    if (!ok) return
    try {
      const res = await window.api.fs.delete(entry.path)
      if (res.error) showNotice(`Delete error: ${res.error}`)
      else {
        showNotice(`Deleted "${entry.name}"`)
        if (previewFile?.path === entry.path) setPreviewFile(null)
        void loadDir(currentPath)
      }
    } catch (err) {
      showNotice(String(err))
    }
  }

  const copyPath = async (path: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(path)
      showNotice('Path copied to clipboard')
    } catch {
      showNotice('Failed to copy path')
    }
  }

  /* Removed: Second Brain file import. */
  /* const createNoteFromFile = async (entry: FileEntry): Promise<void> => {
    try {
      const res = await window.api.fs.readFile(entry.path)
      if ('content' in res && typeof res.content === 'string') {
        const note = await window.api.brain.create({
          title: entry.name,
          content: res.content,
          tags: ['imported', entry.ext.replace(/^\./, '') || 'file'],
          projectDir: workspaceDir || undefined
        })
        if (note && !('error' in note)) {
          showNotice(`Created Note "${entry.name}" in Second Brain`)
        } else {
          // Bus failures resolve with `{ error }` instead of throwing — say so
          // instead of leaving a click that visibly did nothing (UI-audit).
          const reason = note && 'error' in note ? note.error : 'unknown error'
          showNotice(`Failed to create note from file: ${reason}`)
        }
      }
    } catch {
      showNotice('Failed to create note from file')
    }
  } */

  const filteredItems = useMemo(() => {
    if (!search.trim()) return items
    const q = search.trim().toLowerCase()
    return items.filter((item) => item.name.toLowerCase().includes(q))
  }, [items, search])

  const breadcrumbs = useMemo(() => {
    if (!currentPath) return []
    const parts = currentPath.split(/[\\/]/).filter(Boolean)
    const isWindows = /^[a-zA-Z]:/.test(currentPath)
    const crumbs: { label: string; fullPath: string }[] = []

    let accum = isWindows ? '' : '/'
    for (let i = 0; i < parts.length; i++) {
      if (i === 0 && isWindows) {
        accum = `${parts[i]}\\`
      } else {
        accum = isWindows ? (accum.endsWith('\\') ? `${accum}${parts[i]}` : `${accum}\\${parts[i]}`) : `${accum}${parts[i]}/`
      }
      crumbs.push({ label: parts[i], fullPath: accum })
    }
    return crumbs
  }, [currentPath])

  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-panel/95 text-text">
      {/* Top action / navigation bar */}
      <div className="flex flex-none items-center justify-between gap-1.5 border-b border-line-soft px-3 py-2 text-xs">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <button
            className="grid h-6 w-6 flex-none place-items-center rounded-[6px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text disabled:opacity-30"
            disabled={!parentPath || loading}
            onClick={navigateUp}
            title="Go to parent directory"
            aria-label="Parent folder"
          >
            <ArrowLeft size={13} />
          </button>

          {/* Breadcrumbs */}
          <div className="flex items-center gap-0.5 text-[11px] text-text-dim whitespace-nowrap">
            {breadcrumbs.length > 0 ? (
              breadcrumbs.map((crumb, idx) => (
                <React.Fragment key={crumb.fullPath}>
                  {idx > 0 && <ChevronRight size={11} className="flex-none text-text-faint/60" />}
                  <button
                    className={`max-w-[140px] truncate rounded px-1 py-0.5 transition-colors hover:bg-bg-hover hover:text-text ${
                      idx === breadcrumbs.length - 1 ? 'font-semibold text-text' : 'text-text-dim'
                    }`}
                    onClick={() => setCurrentPath(crumb.fullPath)}
                    title={crumb.fullPath}
                  >
                    {crumb.label}
                  </button>
                </React.Fragment>
              ))
            ) : (
              <span className="text-text-faint">No directory open</span>
            )}
          </div>
        </div>

        {/* Action icons */}
        <div className="flex flex-none items-center gap-1">
          <button
            className="grid h-6 w-6 place-items-center rounded-[6px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => {
              setCreatingType('file')
              setNewItemName('')
            }}
            title="New File"
            aria-label="New file"
          >
            <FilePlus size={13} />
          </button>
          <button
            className="grid h-6 w-6 place-items-center rounded-[6px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
            onClick={() => {
              setCreatingType('dir')
              setNewItemName('')
            }}
            title="New Folder"
            aria-label="New folder"
          >
            <FolderPlus size={13} />
          </button>
          <button
            className={`grid h-6 w-6 place-items-center rounded-[6px] transition-colors ${
              loading ? 'animate-spin text-accent' : 'text-text-dim hover:bg-bg-hover hover:text-text'
            }`}
            onClick={() => void loadDir(currentPath)}
            title="Refresh"
            aria-label="Refresh"
          >
            <RefreshCw size={13} />
          </button>
          {currentPath && (
            <button
              className="grid h-6 w-6 place-items-center rounded-[6px] text-text-dim transition-colors hover:bg-bg-hover hover:text-text"
              onClick={() => void window.api.fs.reveal(currentPath)}
              title="Reveal in OS Explorer"
              aria-label="Reveal in OS"
            >
              <ExternalLink size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Search and filter bar */}
      <div className="flex flex-none items-center gap-2 border-b border-line-soft px-3 py-1.5">
        <div className="relative flex min-w-0 flex-1 items-center">
          <Search size={12} className="pointer-events-none absolute left-2 text-text-faint" />
          <input
            className="h-6 w-full rounded-[6px] border border-line-soft bg-bg-hover/30 pr-6 pl-7 text-[11px] text-text outline-none placeholder:text-text-faint focus:border-line focus:bg-bg-hover/60"
            placeholder="Search files…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          {search && (
            <button
              className="absolute right-1.5 text-text-faint hover:text-text"
              onClick={() => setSearch('')}
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={11} />
            </button>
          )}
        </div>

        <button
          className={`rounded-[6px] border px-2 py-0.5 text-[10px] transition-colors ${
            showHidden ? 'border-accent/40 bg-accent/15 text-accent' : 'border-line-soft text-text-faint hover:text-text-dim'
          }`}
          onClick={() => setShowHidden((v) => !v)}
          title="Toggle hidden dotfiles"
        >
          {showHidden ? 'Hidden: On' : 'Hidden: Off'}
        </button>
      </div>

      {/* Action Notice toast */}
      {actionNotice && (
        <div className="flex-none border-b border-accent/30 bg-accent/10 px-3 py-1 text-[11px] text-accent">
          {actionNotice}
        </div>
      )}

      {/* Inline Creation Input Bar */}
      {creatingType && (
        <div className="flex flex-none items-center gap-2 border-b border-line-soft bg-bg-hover/40 px-3 py-1.5">
          {creatingType === 'file' ? <FilePlus size={13} className="text-accent" /> : <FolderPlus size={13} className="text-accent" />}
          <input
            autoFocus
            className="min-w-0 flex-1 rounded border border-line bg-bg px-2 py-1 text-xs text-text outline-none focus:border-accent"
            placeholder={creatingType === 'file' ? 'File name (e.g. index.ts)' : 'Folder name'}
            aria-label={creatingType === 'file' ? 'New file name' : 'New folder name'}
            value={newItemName}
            onChange={(e) => setNewItemName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void handleCreate()
              if (e.key === 'Escape') setCreatingType(null)
            }}
          />
          <button
            className="rounded bg-accent px-2 py-1 text-[11px] font-semibold text-black hover:bg-white disabled:opacity-40"
            disabled={!newItemName.trim()}
            onClick={() => void handleCreate()}
          >
            Create
          </button>
          <button
            className="rounded px-2 py-1 text-[11px] text-text-dim hover:text-text"
            onClick={() => setCreatingType(null)}
          >
            Cancel
          </button>
        </div>
      )}

      {/* Main File Table / List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="p-4 text-center text-xs text-danger">{error}</div>
        ) : filteredItems.length === 0 ? (
          <div className="grid h-full place-items-center p-6 text-center text-xs text-text-faint">
            {loading ? 'Reading folder…' : search ? 'No files match search filter' : 'Folder is empty'}
          </div>
        ) : (
          <table className="w-full border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-line-soft text-[10px] tracking-wider text-text-faint uppercase select-none">
                <th scope="col" className="py-1.5 pr-2 pl-3 font-medium">Name</th>
                <th scope="col" className="w-20 py-1.5 pr-3 text-right font-medium">Size</th>
                <th scope="col" className="w-28 py-1.5 pr-3 text-right font-medium">Modified</th>
                <th scope="col" className="w-20 py-1.5 pr-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredItems.map((entry) => {
                const isRenaming = renamingPath === entry.path
                return (
                  <tr
                    key={entry.path}
                    className="group border-b border-line-soft/40 transition-colors hover:bg-bg-hover/50"
                  >
                    <td className="py-1.5 pr-2 pl-3">
                      {isRenaming ? (
                        <div className="flex items-center gap-1.5">
                          {getFileIcon(entry)}
                          <input
                            autoFocus
                            className="min-w-0 flex-1 rounded border border-accent bg-bg px-1.5 py-0.5 text-xs text-text outline-none"
                            value={renamingName}
                            aria-label="New name"
                            onChange={(e) => setRenamingName(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') {
                                e.preventDefault()
                                void handleRename()
                              }
                              if (e.key === 'Escape') {
                                e.stopPropagation()
                                renameCancelled.current = true
                                setRenamingPath(null)
                              }
                            }}
                            onBlur={() => void handleRename()}
                          />
                        </div>
                      ) : (
                        <button
                          className="flex min-w-0 items-center gap-2 text-left hover:underline"
                          onClick={() => openItem(entry)}
                          title={entry.path}
                        >
                          {getFileIcon(entry)}
                          <span
                            className={`truncate ${
                              entry.isDirectory ? 'font-medium text-text' : 'text-text-dim group-hover:text-text'
                            }`}
                          >
                            {entry.name}
                          </span>
                        </button>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-[11px] tabular-nums text-text-faint">
                      {entry.isDirectory ? '—' : formatBytes(entry.size)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-[10px] tabular-nums text-text-faint">
                      {formatDate(entry.mtime)}
                    </td>
                    <td className="py-1.5 pr-3 text-right">
                      <div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
                        {!entry.isDirectory && (
                          <button
                            className="grid h-5 w-5 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
                            onClick={() => void viewFile(entry.path)}
                            title="Preview file"
                          >
                            <Eye size={12} />
                          </button>
                        )}
                        <button
                          className="grid h-5 w-5 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
                          onClick={() => void window.api.fs.openPath(entry.path)}
                          title="Open in default app"
                        >
                          <ExternalLink size={12} />
                        </button>
                        <button
                          className="grid h-5 w-5 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
                          onClick={() => void copyPath(entry.path)}
                          title="Copy path"
                        >
                          <Copy size={12} />
                        </button>
                        <button
                          className="grid h-5 w-5 place-items-center rounded text-text-dim hover:bg-bg-hover hover:text-text"
                          onClick={() => startRename(entry)}
                          title="Rename"
                        >
                          <Pencil size={12} />
                        </button>
                        <button
                          className="grid h-5 w-5 place-items-center rounded text-text-dim hover:bg-danger/20 hover:text-danger"
                          onClick={() => void handleDelete(entry)}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Bottom Status Bar */}
      <div className="flex flex-none items-center justify-between border-t border-line-soft px-3 py-1 text-[11px] text-text-faint">
        <div>
          {filteredItems.length} {filteredItems.length === 1 ? 'item' : 'items'}
        </div>
        <div className="truncate max-w-[60%]" title={currentPath || ''}>
          {currentPath}
        </div>
      </div>

      {/* File Preview Modal / Drawer. Portaled to <body> on purpose: the widget
          frame is `transform: scale(zoom)` + `overflow-hidden`, and a `fixed`
          overlay inside it would resolve against the transformed ancestor — scaled
          with the canvas and clipped to the widget's box. */}
      {previewFile &&
        createPortal(
          <div
            ref={previewRef}
            role="dialog"
            aria-modal="true"
            aria-label={`Preview ${previewFile.name}`}
            className="pop-in fixed inset-0 z-[12000] flex flex-col bg-bg-panel/95 p-4 shadow-2xl backdrop-blur-xl"
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.stopPropagation()
              setPreviewFile(null)
            }
          }}
        >
          <div className="mb-3 flex flex-none items-center justify-between border-b border-line-soft pb-2">
            <div className="flex items-center gap-2">
              <FileCode size={16} className="text-accent" />
              <div>
                <h3 className="text-sm font-semibold text-text">{previewFile.name}</h3>
                <span className="text-[10px] text-text-faint tabular-nums">
                  {formatBytes(previewFile.size)} · {previewFile.path}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="flex items-center gap-1.5 rounded-[8px] border border-line px-2.5 py-1 text-xs text-text-dim hover:bg-bg-hover hover:text-text"
                onClick={() => void window.api.fs.openPath(previewFile.path)}
              >
                <ExternalLink size={13} /> Open with OS App
              </button>
              {previewFile.content !== undefined && (
                <button
                  className="flex items-center gap-1.5 rounded-[8px] border border-line px-2.5 py-1 text-xs text-text-dim hover:bg-bg-hover hover:text-text"
                  onClick={async () => {
                    // `content` is falsy for a 0-byte file too — still copy and
                    // confirm, otherwise the button feels dead (UI-audit).
                    if (previewFile.content !== undefined) {
                      try {
                        await navigator.clipboard.writeText(previewFile.content)
                        showNotice(previewFile.content ? 'Content copied' : 'File is empty — nothing to copy')
                      } catch (err) {
                        showNotice(`Copy failed: ${err instanceof Error ? err.message : String(err)}`)
                      }
                    }
                  }}
                >
                  <Copy size={13} /> Copy Text
                </button>
              )}
              <button
                className="grid h-7 w-7 place-items-center rounded-[8px] text-text-dim hover:bg-bg-hover hover:text-text"
                onClick={() => setPreviewFile(null)}
                title="Close Preview (Esc)"
              >
                <X size={15} />
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-auto rounded-[8px] border border-line-soft bg-black/40 p-3">
            {previewFile.isImage && previewFile.dataUrl ? (
              <div className="grid h-full place-items-center">
                <img
                  src={previewFile.dataUrl}
                  alt={previewFile.name}
                  className="max-h-full max-w-full rounded object-contain"
                />
              </div>
            ) : previewFile.isBinary ? (
              <div className="grid h-full place-items-center text-xs text-text-faint">
                Binary file preview not available. Open with external application.
              </div>
            ) : previewFile.content !== undefined ? (
              <pre className="font-mono text-xs leading-relaxed text-text whitespace-pre-wrap select-text">
                {previewFile.content}
              </pre>
            ) : (
              <div className="grid h-full place-items-center text-xs text-text-faint">No content</div>
            )}
          </div>
        </div>
        ,
        document.body
      )}
    </div>
  )
})
