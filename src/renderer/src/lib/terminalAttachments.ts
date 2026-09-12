export function isTerminalPasteShortcut(event: Pick<KeyboardEvent, 'key' | 'code' | 'keyCode' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>, isMac: boolean): boolean {
  const key = event.key.toLowerCase()
  const v = key === 'v' || key === 'м' || event.code === 'KeyV' || event.keyCode === 86
  const insert = event.key === 'Insert' || event.code === 'Insert' || event.keyCode === 45
  // Win+V belongs to the OS clipboard history. Its resulting paste event is
  // handled normally, after the user chooses an item.
  if (event.metaKey) return isMac && !event.ctrlKey && !event.altKey && v
  if (event.altKey) return !event.ctrlKey && !event.shiftKey && v
  if (event.ctrlKey && v) return true
  return event.shiftKey && !event.ctrlKey && insert
}

export function attachmentAgent(command: string): string | undefined {
  const executable = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/)
  const name = (executable?.[1] ?? executable?.[2] ?? executable?.[3] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, '')
  if (name === 'cursor-agent' || name === 'agent') return 'cursor'
  if (name === 'agy') return 'antigravity'
  if (name && ['claude', 'codex', 'kimi', 'grok', 'opencode', 'cursor', 'commandcode', 'pi', 'antigravity'].includes(name)) return name
  return undefined
}

export function imagePasteShortcut(agent: string | undefined, platform: string): string | null {
  const name = attachmentAgent(agent ?? '')
  if (name && ['claude', 'kimi', 'grok', 'commandcode', 'pi'].includes(name)) return platform === 'win32' ? '\x1bv' : '\x16'
  if (name === 'codex' || name === 'opencode' || name === 'cursor' || name === 'antigravity') return '\x16'
  return null
}

export interface AttachmentFile {
  name: string
  type: string
  size: number
  arrayBuffer(): Promise<ArrayBuffer>
}

interface AttachmentDependencies {
  getPath(file: AttachmentFile): string
  save(bytes: Uint8Array, ext: string): Promise<{ path: string } | { error: string } | null>
  stage(bytes: Uint8Array): Promise<{ ok: true } | { error: string }>
  paste(text: string): void
  write(text: string): void
  report(message: string): void
  alive(): boolean
}

export async function insertAttachments(files: AttachmentFile[], shortcut: string | null, deps: AttachmentDependencies): Promise<void> {
  for (const file of files) {
    if (!deps.alive()) return
    try {
      const image = file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|avif|bmp|svg|heic|tiff?)$/i.test(file.name)
      let bytes: Uint8Array | undefined
      const read = async (): Promise<Uint8Array> => {
        if (file.size > 256 * 1024 * 1024) throw new Error('File exceeds 256 MB')
        return bytes ??= new Uint8Array(await file.arrayBuffer())
      }
      // A CLI reads the clipboard asynchronously. Use durable paths for a batch
      // so later images cannot overwrite the first before it is consumed.
      if (image && shortcut && files.length === 1) {
        const staged = await deps.stage(await read())
        if (!deps.alive()) return
        if ('ok' in staged) {
          deps.write(shortcut)
          return
        }
      }
      let path = ''
      try { path = deps.getPath(file) } catch { /* Virtual files may not expose an OS path. */ }
      if (!path) {
        const ext = file.name.match(/\.([a-z0-9]+)$/i)?.[1] ?? (image ? 'png' : file.type === 'audio/mpeg' ? 'mp3' : 'bin')
        const saved = await deps.save(await read(), ext)
        if (!saved || 'error' in saved) throw new Error(saved && 'error' in saved ? saved.error : 'Could not save attachment')
        path = saved.path
      }
      if (!deps.alive()) return
      if (/[\x00-\x1f\x7f]/.test(path)) throw new Error('Attachment path contains control characters')
      deps.paste(`"${path.replace(/"/g, '\\"')}" `)
    } catch (error) {
      if (deps.alive()) deps.report(`${file.name}: ${error instanceof Error ? error.message : 'Could not attach file'}`)
    }
  }
}
