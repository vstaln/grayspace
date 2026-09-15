export function codeWorkspaceScope(folder: string | null | undefined, id: string): string {
  const key = folder ? folder.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase() : '__no-folder__'
  return `${key}\u0000${id}`
}
