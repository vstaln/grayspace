export const TERMINAL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/

export const MAX_FAVORITE_TERMINAL_NAMES = 32

const DEFAULT_TITLE_PATTERN = /^(Agent\s+)?Terminal\s+\d+$/i

const MAX_NAME_LENGTH = 32

function withSuffix(base: string, n: number): string {
  const suffix = `-${n}`
  return `${base.slice(0, MAX_NAME_LENGTH - suffix.length)}${suffix}`
}

const MALE_NAMES = [
  'James', 'Henry', 'Oliver', 'William', 'Jack', 'George', 'Thomas', 'Charles',
  'Edward', 'Arthur', 'Harry', 'John', 'Robert', 'Michael', 'David', 'Daniel',
  'Samuel', 'Joseph', 'Benjamin', 'Alexander', 'Matthew', 'Andrew', 'Joshua', 'Nathan',
  'Peter', 'Paul', 'Luke', 'Mark', 'Adam', 'Simon', 'Isaac', 'Noah',
  'Liam', 'Ethan', 'Jacob', 'Oscar', 'Leo', 'Louis', 'Frederick', 'Albert',
  'Alfred', 'Theodore', 'Sebastian', 'Nicholas', 'Anthony', 'Jonathan', 'Christopher', 'Patrick',
  'Richard', 'Philip', 'Stephen', 'Victor', 'Vincent', 'Hugo', 'Miles', 'Julian',
  'Caleb', 'Dylan', 'Owen', 'Connor', 'Ryan', 'Aaron', 'Adrian', 'Eric'
]

export function normalizeTerminalName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.trim()
  if (!TERMINAL_NAME_PATTERN.test(name)) return null
  return name
}

export function normalizeTerminalNameList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const item of raw) {
    const name = normalizeTerminalName(item)
    if (!name) continue
    const key = name.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
    if (out.length >= MAX_FAVORITE_TERMINAL_NAMES) break
  }
  return out
}

export function isDefaultTerminalTitle(title: string): boolean {
  return DEFAULT_TITLE_PATTERN.test(title.trim())
}

export function makeUniqueTitle(base: string, taken: Set<string> | Iterable<string>): string {
  const clean = (base.trim() || 'terminal').slice(0, MAX_NAME_LENGTH)
  const lower = new Set<string>()
  for (const title of taken) lower.add(title.toLowerCase())
  if (!lower.has(clean.toLowerCase())) return clean
  let n = 2
  while (lower.has(withSuffix(clean, n).toLowerCase())) n += 1
  return withSuffix(clean, n)
}

export function randomTerminalName(rand: () => number = Math.random): string {
  return MALE_NAMES[Math.floor(rand() * MALE_NAMES.length)]
}

export function pickTerminalName(options: {
  favorites?: string[]
  taken?: Iterable<string>
  rand?: () => number
}): string {
  const { favorites = [], rand = Math.random } = options
  const taken = new Set<string>()
  if (options.taken) {
    for (const title of options.taken) taken.add(title.toLowerCase())
  }
  for (const favorite of favorites) {
    const name = normalizeTerminalName(favorite)
    if (name && !taken.has(name.toLowerCase())) return name
  }
  const start = Math.floor(rand() * MALE_NAMES.length)
  for (let offset = 0; offset < MALE_NAMES.length; offset += 1) {
    const name = MALE_NAMES[(start + offset) % MALE_NAMES.length]
    if (!taken.has(name.toLowerCase())) return name
  }
  const base = MALE_NAMES[start]
  let n = 2
  while (taken.has(withSuffix(base, n).toLowerCase())) n += 1
  return withSuffix(base, n)
}
