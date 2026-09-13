import { stripVTControlCharacters } from 'node:util'

export interface ChatAuthDetails {
  url?: string
  userCode?: string
  requiresInput: boolean
}

function allowedUrl(raw: string, allowedHosts: string[]): boolean {
  try {
    const url = new URL(raw)
    if (url.protocol !== 'https:') return false
    const host = url.hostname.toLowerCase()
    return allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  } catch {
    return false
  }
}

export function extractChatAuthDetails(raw: string, allowedHosts: string[]): ChatAuthDetails {
  const text = stripVTControlCharacters(raw)
  const url = (text.match(/https:\/\/[^\s<>"']+/g) ?? [])
    .map((value) => value.replace(/[),.;]+$/, ''))
    .find((value) => allowedUrl(value, allowedHosts))
  const userCode = text.match(/\b[A-Z0-9]{4,8}(?:-[A-Z0-9]{4,8}){1,3}\b/)?.[0]
  return {
    url,
    userCode,
    requiresInput: /paste (?:the )?(?:oauth )?code|paste code here|enter (?:the )?(?:oauth )?code/i.test(text)
  }
}
