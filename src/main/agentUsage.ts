import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFile } from 'child_process'
import type { AgentUsageItem, AgentUsageWindow } from '../preload/api.ts'
import type { IpcDeps } from './ipc/types.ts'

interface AgentConfig {
  id: string
  name: string
  command: string
  processNames: string[]
  outputKeywords: string[]
  historyPaths: string[]
  presenceDirPath?: string
  isSecondTimestamp?: boolean
  limit5h: number
  limitWeekly: number
  limitMonthly: number
  hasMonthlyLimit?: boolean
}

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

interface ExactQuotaData {
  fiveHourRemaining?: number
  fiveHourUsed?: number
  fiveHourRefreshes?: string
  weeklyRemaining?: number
  weeklyUsed?: number
  weeklyRefreshes?: string
  monthlyRemaining?: number
  monthlyUsed?: number
  monthlyRefreshes?: string
  accountEmail?: string
  modelName?: string
  tierName?: string
  updatedAt: number
}

const exactQuotaCache = new Map<string, ExactQuotaData>()

interface LogCacheEntry {
  mtimeMs: number
  size: number
  lastTs: number
  tokensMonthly: number
  requestsMonthly: number
  tokensWeekly: number
  requestsWeekly: number
  tokens5h: number
  requests5h: number
  oldest5h: number | null
}
const logCache = new Map<string, LogCacheEntry>()

function parseQuotaFromTerminalOutput(rawText: string): ExactQuotaData | null {
  if (!rawText) return null

  const clean = rawText
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\([a-zA-Z]/g, '')
    .replace(/\r/g, '')

  let found = false
  const result: ExactQuotaData = {
    updatedAt: Date.now()
  }


  const emailMatch = clean.match(/(?:Account|Logged in as|User)[:\s]+([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/i)
  if (emailMatch) {
    result.accountEmail = emailMatch[1].trim()
    found = true
  }


  const tierMatch = clean.match(/(?:Plan|Tier|Subscription|\()?\s*(Google AI Pro|Claude Pro|ChatGPT Plus|Pro Plan|Team Plan|Enterprise)\s*\)?/i)
  if (tierMatch) {
    result.tierName = tierMatch[1].trim()
    found = true
  }


  const modelMatch = clean.match(/(Gemini\s+(?:3\.7|3|2\.5|2\.0|1\.5)\s+(?:Flash|Pro)(?:\s*\((?:High|Medium|Low)\))?|Claude\s+(?:3\.7|3\.5)\s+(?:Sonnet|Opus|Haiku)|GPT-4o|o3-mini|o1|DeepSeek[- ](?:V3|R1))/i)
  if (modelMatch) {
    result.modelName = modelMatch[1].trim()
    found = true
  }


  const weeklyMatch = clean.match(/Weekly\s+Limit\s+Remaining[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*%/i)
  if (weeklyMatch) {
    const rem = parseFloat(weeklyMatch[1])
    if (!isNaN(rem) && rem >= 0 && rem <= 100) {
      result.weeklyRemaining = rem
      result.weeklyUsed = parseFloat((100 - rem).toFixed(2))
      found = true
    }
  }

  const weeklyRefreshesMatch = clean.match(/Refreshes\s+in\s+([0-9]+\s*h(?:\s*[0-9]+\s*m)?|[0-9]+\s*m|[0-9]+\s*d(?:\s*[0-9]+\s*h)?)/i)
  if (weeklyRefreshesMatch) {
    result.weeklyRefreshes = weeklyRefreshesMatch[1].trim()
    found = true
  }


  const fiveHourMatch = clean.match(/(?:Five\s+Hour|5[- ]?Hour)\s+Limit\s+Remaining[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*%/i)
  if (fiveHourMatch) {
    const rem = parseFloat(fiveHourMatch[1])
    if (!isNaN(rem) && rem >= 0 && rem <= 100) {
      result.fiveHourRemaining = rem
      result.fiveHourUsed = parseFloat((100 - rem).toFixed(2))
      found = true
    }
  }


  const monthlyMatch = clean.match(/(?:Monthly|Month|30[- ]?Day)\s+(?:Limit\s+Remaining|Quota)[\s\S]*?([0-9]+(?:\.[0-9]+)?)\s*%/i)
  if (monthlyMatch) {
    const rem = parseFloat(monthlyMatch[1])
    if (!isNaN(rem) && rem >= 0 && rem <= 100) {
      result.monthlyRemaining = rem
      result.monthlyUsed = parseFloat((100 - rem).toFixed(2))
      found = true
    }
  }

  const monthlyRefreshesMatch = clean.match(/(?:Monthly|Month|30[- ]?day)\s+refreshes\s+in\s+([0-9]+\s*d(?:\s*[0-9]+\s*h)?|[0-9]+\s*days?)/i)
  if (monthlyRefreshesMatch) {
    result.monthlyRefreshes = monthlyRefreshesMatch[1].trim()
    found = true
  }


  if (!result.fiveHourRemaining) {
    const alt5hMatch = clean.match(/5h\s*(?:limit|quota|session)?\s*[:=-]?\s*([0-9]+(?:\.[0-9]+)?)\s*%\s*(?:remaining|rem)/i)
    if (alt5hMatch) {
      const rem = parseFloat(alt5hMatch[1])
      result.fiveHourRemaining = rem
      result.fiveHourUsed = parseFloat((100 - rem).toFixed(2))
      found = true
    }
  }

  return found ? result : null
}

function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return '5h window ready'
  const totalMinutes = Math.ceil(ms / (60 * 1000))
  const hours = Math.floor(totalMinutes / 60)
  const mins = totalMinutes % 60
  if (hours > 0) {
    return `Resets in ${hours}h ${mins}m`
  }
  return `Resets in ${mins}m`
}

function parseJsonlHistory(filePaths: string[], isSec = false): {
  requests5h: number
  requestsWeekly: number
  requestsMonthly: number
  tokens5h: number
  tokensWeekly: number
  tokensMonthly: number
  lastTs: number
  oldest5h: number
  fileModifiedRecently: boolean
} {
  let requests5h = 0
  let requestsWeekly = 0
  let requestsMonthly = 0
  let tokens5h = 0
  let tokensWeekly = 0
  let tokensMonthly = 0
  let lastTs = 0
  let oldest5h = 0
  let fileModifiedRecently = false

  const now = Date.now()
  const fiveHAgo = now - FIVE_HOURS_MS
  const sevenDAgo = now - SEVEN_DAYS_MS
  const thirtyDAgo = now - THIRTY_DAYS_MS

  for (const filePath of filePaths) {
    try {
      if (!fs.existsSync(filePath)) continue
      const stat = fs.statSync(filePath)
      if (now - stat.mtimeMs < 15 * 60 * 1000) {
        fileModifiedRecently = true
      }

      const cached = logCache.get(filePath)
      let fileTokensMonthly = 0
      let fileRequestsMonthly = 0
      let fileTokensWeekly = 0
      let fileRequestsWeekly = 0
      let fileTokens5h = 0
      let fileRequests5h = 0
      let fileLastTs = 0
      let fileOldest5h: number | null = null

      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        fileTokensMonthly = cached.tokensMonthly
        fileRequestsMonthly = cached.requestsMonthly
        fileTokensWeekly = cached.tokensWeekly
        fileRequestsWeekly = cached.requestsWeekly
        fileTokens5h = cached.tokens5h
        fileRequests5h = cached.requests5h
        fileLastTs = cached.lastTs
        fileOldest5h = cached.oldest5h
      } else {
        let content = ''
        const maxBytes = 4 * 1024 * 1024
        if (stat.size > maxBytes) {
          const buf = Buffer.alloc(maxBytes)
          const fd = fs.openSync(filePath, 'r')
          try {
            fs.readSync(fd, buf, 0, maxBytes, stat.size - maxBytes)
          } finally {
            fs.closeSync(fd)
          }
          content = buf.toString('utf8')
        } else {
          content = fs.readFileSync(filePath, 'utf8')
        }

        const lines = content.split('\n')
        for (let i = lines.length - 1; i >= 0; i--) {
          const line = lines[i].trim()
          if (!line) continue
          try {
            const item = JSON.parse(line)
            let ts = item.timestamp || item.ts || (item.created_at ? new Date(item.created_at).getTime() : 0)
            if (!ts) continue
            if (isSec && ts < 1e11) ts *= 1000
            if (ts > fileLastTs) fileLastTs = ts
            if (ts < thirtyDAgo) {
              break
            }

            const tok =
              item.tokens ||
              item.token_count ||
              item.total_tokens ||
              (item.prompt_tokens ? item.prompt_tokens + (item.candidates_tokens || item.completion_tokens || 0) : 0) ||
              0

            fileRequestsMonthly++
            fileTokensMonthly += tok

            if (ts >= sevenDAgo) {
              fileRequestsWeekly++
              fileTokensWeekly += tok
            }
            if (ts >= fiveHAgo) {
              fileRequests5h++
              fileTokens5h += tok
              if (!fileOldest5h || ts < fileOldest5h) {
                fileOldest5h = ts
              }
            }
          } catch {

          }
        }

        logCache.set(filePath, {
          mtimeMs: stat.mtimeMs,
          size: stat.size,
          lastTs: fileLastTs,
          tokensMonthly: fileTokensMonthly,
          requestsMonthly: fileRequestsMonthly,
          tokensWeekly: fileTokensWeekly,
          requestsWeekly: fileRequestsWeekly,
          tokens5h: fileTokens5h,
          requests5h: fileRequests5h,
          oldest5h: fileOldest5h
        })
      }

      requestsMonthly += fileRequestsMonthly
      tokensMonthly += fileTokensMonthly
      requestsWeekly += fileRequestsWeekly
      tokensWeekly += fileTokensWeekly
      requests5h += fileRequests5h
      tokens5h += fileTokens5h
      if (fileLastTs > lastTs) lastTs = fileLastTs
      if (fileOldest5h && (!oldest5h || fileOldest5h < oldest5h)) {
        oldest5h = fileOldest5h
      }
    } catch {

    }
  }

  return { requests5h, requestsWeekly, requestsMonthly, tokens5h, tokensWeekly, tokensMonthly, lastTs, oldest5h, fileModifiedRecently }
}

let cachedProcList = ''
let lastProcCheckTime = 0

function getProcessList(): Promise<string> {
  const now = Date.now()
  if (cachedProcList && now - lastProcCheckTime < 2500) {
    return Promise.resolve(cachedProcList)
  }

  return new Promise((resolve) => {
    const isWin = os.platform() === 'win32'
    if (isWin) {
      execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
        if (!err && stdout) {
          cachedProcList = stdout.toLowerCase()
          lastProcCheckTime = Date.now()
        }
        resolve(cachedProcList)
      })
    } else {
      execFile('ps', ['-A', '-o', 'comm'], { timeout: 3000 }, (err, stdout) => {
        if (!err && stdout) {
          cachedProcList = stdout.toLowerCase()
          lastProcCheckTime = Date.now()
        }
        resolve(cachedProcList)
      })
    }
  })
}

function checkPresenceLocks(dirPath?: string): boolean {
  if (!dirPath) return false
  try {
    if (!fs.existsSync(dirPath)) return false
    const files = fs.readdirSync(dirPath)
    const now = Date.now()
    for (const f of files) {
      if (!f.endsWith('.lock')) continue
      const stat = fs.statSync(path.join(dirPath, f))
      if (now - stat.mtimeMs < 5 * 60_000) return true
    }
  } catch {

  }
  return false
}

export async function getAgentUsageStats(deps?: IpcDeps): Promise<AgentUsageItem[]> {
  const home = os.homedir()
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const procList = await getProcessList()
  const now = Date.now()

  const AGENTS: AgentConfig[] = [
    {
      id: 'antigravity',
      name: 'Antigravity',
      command: 'agy',
      processNames: ['agy.exe', 'agy', 'antigravity.exe', 'antigravity'],
      outputKeywords: ['antigravity cli', 'gemini 3.7', 'google ai pro', 'gemini flash', 'agy'],
      historyPaths: [path.join(home, '.gemini', 'antigravity-cli', 'history.jsonl')],
      presenceDirPath: path.join(home, '.gemini', 'antigravity-cli', 'presence'),
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 2000,
      hasMonthlyLimit: true
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      command: 'opencode',
      processNames: ['opencode.exe', 'opencode', 'open-code.exe', 'open-code'],
      outputKeywords: ['opencode', 'open-code', 'opencode interpreter', 'opencode ai'],
      historyPaths: [
        path.join(home, '.opencode', 'history.jsonl'),
        path.join(home, '.config', 'opencode', 'history.jsonl'),
        path.join(home, '.local', 'share', 'opencode', 'history.jsonl'),
        path.join(appData, 'opencode', 'history.jsonl'),
        path.join(localAppData, 'opencode', 'history.jsonl')
      ],
      presenceDirPath: path.join(home, '.opencode', 'presence'),
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 2000,
      hasMonthlyLimit: true
    },
    {
      id: 'codex',
      name: 'Codex',
      command: 'codex',
      processNames: ['codex.exe', 'codex'],
      outputKeywords: ['codex', 'openai codex'],
      historyPaths: [path.join(home, '.codex', 'history.jsonl')],
      isSecondTimestamp: true,
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 2000,
      hasMonthlyLimit: true
    },
    {
      id: 'claude',
      name: 'Claude Code',
      command: 'claude',
      processNames: ['claude.exe', 'claude'],
      outputKeywords: ['claude code', 'claude-sonnet', 'claude-opus'],
      historyPaths: [path.join(home, '.claude', 'history.jsonl')],
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 2000,
      hasMonthlyLimit: true
    },
    {
      id: 'grok',
      name: 'Grok',
      command: 'grok',
      processNames: ['grok.exe', 'grok'],
      outputKeywords: ['grok', 'xai grok'],
      historyPaths: [path.join(home, '.grok', 'history.jsonl')],
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 2000,
      hasMonthlyLimit: true
    },
    {
      id: 'cursor',
      name: 'Cursor Agent',
      command: 'cursor-agent',
      processNames: ['cursor-agent.exe', 'cursor-agent', 'cursor.exe', 'cursor'],
      outputKeywords: ['cursor agent', 'cursor'],
      historyPaths: [path.join(home, '.cursor', 'history.jsonl')],
      limit5h: 100,
      limitWeekly: 500,
      limitMonthly: 500,
      hasMonthlyLimit: true
    }
  ]


  const activeTerminals = deps?.terminals ? deps.terminals.list() : []


  if (deps?.terminals && typeof deps.terminals.fullOutput === 'function') {
    for (const t of activeTerminals) {
      if (!t.alive) continue
      try {
        const fullOut = deps.terminals.fullOutput(t.id) || ''
        const out = fullOut.length > 8192 ? fullOut.slice(-8192) : fullOut
        const parsed = parseQuotaFromTerminalOutput(out)
        if (parsed) {
          const lowerOut = out.toLowerCase()
          for (const ag of AGENTS) {
            if (ag.outputKeywords.some((kw) => lowerOut.includes(kw)) || t.title.toLowerCase().includes(ag.command)) {
              const existing = exactQuotaCache.get(ag.id) || { updatedAt: 0 }
              exactQuotaCache.set(ag.id, {
                ...existing,
                ...parsed,
                updatedAt: Date.now()
              })
              break
            }
          }
        }
      } catch {

      }
    }
  }



  const tails: string[] = deps?.terminals && typeof deps.terminals.fullOutput === 'function'
    ? activeTerminals.map((t) => {
        if (!t.alive) return ''
        try {
          const out = deps.terminals.fullOutput(t.id) || ''
          return out.slice(-8_000).toLowerCase()
        } catch {
          return ''
        }
      })
    : activeTerminals.map(() => '')

  return AGENTS.map((agent) => {

    let openCount = 0
    const lowerId = agent.id.toLowerCase()
    const lowerCmd = agent.command.toLowerCase()
    const lowerName = agent.name.toLowerCase()

    for (let i = 0; i < activeTerminals.length; i += 1) {
      const t = activeTerminals[i]
      if (!t.alive) continue
      const lowerTitle = (t.title || '').toLowerCase()
      const lowerTId = (t.id || '').toLowerCase()
      let matches =
        lowerTitle.includes(lowerId) ||
        lowerTitle.includes(lowerCmd) ||
        lowerTitle.includes(lowerName) ||
        lowerTId.includes(lowerId)

      if (!matches && tails[i] && agent.outputKeywords.some((kw) => (tails[i] as string).includes(kw))) {
        matches = true
      }

      if (matches) {
        openCount++
      }
    }


    const hasProc = agent.processNames.some((pName) => procList.includes(pName.toLowerCase()))
    const hasPresence = checkPresenceLocks(agent.presenceDirPath)


    const { requests5h, requestsWeekly, requestsMonthly, tokens5h, tokensWeekly, tokensMonthly, lastTs, oldest5h, fileModifiedRecently } =
      parseJsonlHistory(agent.historyPaths, agent.isSecondTimestamp)


    const recentActivity = lastTs > 0 && now - lastTs < 10 * 60 * 1000

    const isOpen = openCount > 0 || hasProc || hasPresence || (fileModifiedRecently && recentActivity)

    const percent5h = Math.min(100, Math.round((requests5h / agent.limit5h) * 100))
    const percentWeekly = Math.min(100, Math.round((requestsWeekly / agent.limitWeekly) * 100))
    const percentMonthly = Math.min(100, Math.round((requestsMonthly / agent.limitMonthly) * 100))

    let resetInfo5h = '5h window ready'
    let resetAt5h: number | undefined
    if (requests5h > 0 && oldest5h > 0) {
      resetAt5h = oldest5h + FIVE_HOURS_MS
      const msLeft = Math.max(0, resetAt5h - now)
      resetInfo5h = formatTimeRemaining(msLeft)
    }


    const exact = exactQuotaCache.get(agent.id)
    const hasExactQuota = Boolean(
      exact &&
        (exact.fiveHourRemaining !== undefined ||
          exact.weeklyRemaining !== undefined ||
          exact.monthlyRemaining !== undefined)
    )

    const fiveHourRemaining = exact?.fiveHourRemaining ?? Math.max(0, 100 - percent5h)
    const fiveHourUsed = exact?.fiveHourUsed ?? percent5h

    const weeklyRemaining = exact?.weeklyRemaining ?? Math.max(0, 100 - percentWeekly)
    const weeklyUsed = exact?.weeklyUsed ?? percentWeekly

    const monthlyRemaining = exact?.monthlyRemaining ?? Math.max(0, 100 - percentMonthly)
    const monthlyUsed = exact?.monthlyUsed ?? percentMonthly

    const weeklyResetInfo = exact?.weeklyRefreshes
      ? `Refreshes in ${exact.weeklyRefreshes}`
      : '7-day rolling window'

    const monthlyResetInfo = exact?.monthlyRefreshes
      ? `Refreshes in ${exact.monthlyRefreshes}`
      : '30-day rolling window'

    const fiveHour: AgentUsageWindow = {
      percent: fiveHourRemaining,
      remainingPercent: fiveHourRemaining,
      usedPercent: fiveHourUsed,
      requests: requests5h,
      tokens: tokens5h || undefined,
      limit: agent.limit5h,
      resetInfo: exact?.fiveHourRefreshes ? `Refreshes in ${exact.fiveHourRefreshes}` : resetInfo5h,
      resetAt: resetAt5h
    }

    const weekly: AgentUsageWindow = {
      percent: weeklyRemaining,
      remainingPercent: weeklyRemaining,
      usedPercent: weeklyUsed,
      requests: requestsWeekly,
      tokens: tokensWeekly || undefined,
      limit: agent.limitWeekly,
      resetInfo: weeklyResetInfo,
      refreshesIn: exact?.weeklyRefreshes
    }

    const monthly: AgentUsageWindow | undefined = agent.hasMonthlyLimit
      ? {
          percent: monthlyRemaining,
          remainingPercent: monthlyRemaining,
          usedPercent: monthlyUsed,
          requests: requestsMonthly,
          tokens: tokensMonthly || undefined,
          limit: agent.limitMonthly,
          resetInfo: monthlyResetInfo,
          refreshesIn: exact?.monthlyRefreshes
        }
      : undefined

    return {
      id: agent.id,
      name: agent.name,
      command: agent.command,
      isOpen,
      openCount: openCount || (isOpen ? 1 : 0),
      fiveHour,
      weekly,
      monthly,
      lastActiveAt: lastTs || undefined,
      hasExactQuota,
      accountEmail: exact?.accountEmail,
      modelName: exact?.modelName,
      tierName: exact?.tierName
    }
  })
}
