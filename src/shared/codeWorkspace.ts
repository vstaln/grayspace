export function codeWorkspaceScope(folder: string | null | undefined, id: string): string {
  const normalized = folder ? folder.replace(/\\/g, '/').replace(/\/$/, '') : ''
  const key = normalized
    ? (/^[a-z]:\//i.test(normalized) || normalized.startsWith('//') ? normalized.toLowerCase() : normalized)
    : '__no-folder__'
  return `${key}\u0000${id}`
}
