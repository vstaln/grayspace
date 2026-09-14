import { promises as fsp } from 'fs'

/**
 * A read-only reader for the handful of SQLite stores the agent CLIs keep.
 *
 * Nothing here writes, locks or upgrades a database: it opens the file, walks
 * one table's b-tree and hands back rows. That is deliberate — the CLI that
 * owns the file may be running, and a native driver would be both a build
 * dependency and a way to corrupt someone's history. A store we cannot make
 * sense of yields no rows rather than an error.
 *
 * WAL is supported because the stores we read are in WAL mode: the newest
 * conversations — the ones worth resuming — usually live only in the log until
 * the CLI checkpoints it, so a main-file-only read would miss exactly them.
 */

export type SqliteValue = string | number | bigint | null | Uint8Array
export type SqliteRow = Record<string, SqliteValue>

export interface ReadTableOptions {
  /** Stop after this many rows. */
  maxRows?: number
  /** Guards against a corrupt b-tree that points at itself. */
  maxPages?: number
  /**
   * How much of one record to assemble. Columns past the cut decode as null,
   * which is why callers should ask for the small columns they need and let a
   * fat blob at the end of the row go unread.
   */
  maxPayloadBytes?: number
}

const DEFAULTS = { maxRows: 5_000, maxPages: 50_000, maxPayloadBytes: 128 * 1024 }
const HEADER_BYTES = 100
const WAL_HEADER_BYTES = 32
const WAL_FRAME_HEADER_BYTES = 24
const WAL_MAGIC = [0x377f0682, 0x377f0683]

interface Pager {
  pageSize: number
  usable: number
  pageCount: number
  read(page: number): Promise<Buffer | null>
  close(): Promise<void>
}

function readVarint(buf: Buffer, offset: number): { value: number; size: number } {
  let value = 0n
  let size = 0
  while (size < 8) {
    const byte = buf[offset + size]
    if (byte === undefined) return { value: 0, size: 0 }
    value = (value << 7n) | BigInt(byte & 0x7f)
    size += 1
    if ((byte & 0x80) === 0) return { value: Number(BigInt.asIntN(64, value)), size }
  }
  const last = buf[offset + 8]
  if (last === undefined) return { value: 0, size: 0 }
  value = (value << 8n) | BigInt(last)
  return { value: Number(BigInt.asIntN(64, value)), size: 9 }
}

/** The newest committed write per page held in a WAL. */
async function walOverlay(file: string, pageSize: number): Promise<Map<number, Buffer>> {
  const overlay = new Map<number, Buffer>()
  let handle: Awaited<ReturnType<typeof fsp.open>> | null = null
  try {
    handle = await fsp.open(`${file}-wal`, 'r')
    const { size } = await handle.stat()
    if (size < WAL_HEADER_BYTES) return overlay
    const header = Buffer.allocUnsafe(WAL_HEADER_BYTES)
    await handle.read(header, 0, WAL_HEADER_BYTES, 0)
    if (!WAL_MAGIC.includes(header.readUInt32BE(0))) return overlay
    // A log written for another page size belongs to a database we are not
    // looking at; reading its frames would splice in foreign pages.
    if (header.readUInt32BE(8) !== pageSize) return overlay
    const salt1 = header.readUInt32BE(16)
    const salt2 = header.readUInt32BE(20)

    const frameSize = WAL_FRAME_HEADER_BYTES + pageSize
    const pending = new Map<number, Buffer>()
    for (let offset = WAL_HEADER_BYTES; offset + frameSize <= size; offset += frameSize) {
      const frame = Buffer.allocUnsafe(frameSize)
      const { bytesRead } = await handle.read(frame, 0, frameSize, offset)
      if (bytesRead < frameSize) break
      // Salts change on every reset, so a frame carrying the old pair is
      // leftover space rather than data — and so is everything after it.
      if (frame.readUInt32BE(8) !== salt1 || frame.readUInt32BE(12) !== salt2) break
      const page = frame.readUInt32BE(0)
      const commit = frame.readUInt32BE(4)
      if (page > 0) pending.set(page, frame.subarray(WAL_FRAME_HEADER_BYTES))
      // Only a commit frame makes the writes before it visible; a half-written
      // transaction at the tail of the log is left out.
      if (commit > 0) {
        for (const [key, value] of pending) overlay.set(key, value)
        pending.clear()
      }
    }
  } catch {
    // No log, or one we cannot read: the main file alone still answers.
  } finally {
    await handle?.close().catch(() => {})
  }
  return overlay
}

async function openPager(file: string): Promise<Pager | null> {
  const handle = await fsp.open(file, 'r').catch(() => null)
  if (!handle) return null
  try {
    const header = Buffer.allocUnsafe(HEADER_BYTES)
    const { bytesRead } = await handle.read(header, 0, HEADER_BYTES, 0)
    if (bytesRead < HEADER_BYTES || header.subarray(0, 15).toString('latin1') !== 'SQLite format 3') {
      await handle.close()
      return null
    }
    const rawPageSize = header.readUInt16BE(16)
    const pageSize = rawPageSize === 1 ? 65536 : rawPageSize
    const usable = pageSize - header.readUInt8(20)
    if (pageSize < 512 || (pageSize & (pageSize - 1)) !== 0 || usable < 480) {
      await handle.close()
      return null
    }
    const { size } = await handle.stat()
    const overlay = await walOverlay(file, pageSize)
    const fromFile = Math.floor(size / pageSize)
    let pageCount = fromFile
    for (const page of overlay.keys()) if (page > pageCount) pageCount = page

    return {
      pageSize,
      usable,
      pageCount,
      async read(page: number): Promise<Buffer | null> {
        if (page < 1 || page > pageCount) return null
        const logged = overlay.get(page)
        if (logged) return logged
        if (page > fromFile) return null
        const buffer = Buffer.allocUnsafe(pageSize)
        const { bytesRead: got } = await handle!.read(buffer, 0, pageSize, (page - 1) * pageSize)
        return got === pageSize ? buffer : null
      },
      close: async () => {
        await handle!.close().catch(() => {})
      }
    }
  } catch {
    await handle.close().catch(() => {})
    return null
  }
}

/** One cell's record bytes, following the overflow chain when there is one. */
async function cellPayload(
  pager: Pager,
  page: Buffer,
  offset: number,
  payloadSize: number,
  limit: number
): Promise<Buffer> {
  const usable = pager.usable
  const maxLocal = usable - 35
  let local = payloadSize
  if (payloadSize > maxLocal) {
    const min = Math.floor(((usable - 12) * 32) / 255) - 23
    const k = min + ((payloadSize - min) % (usable - 4))
    local = k <= maxLocal ? k : min
  }
  if (local < 0 || offset + local > page.length) return page.subarray(offset)
  const head = page.subarray(offset, offset + local)
  if (local >= payloadSize) return head

  const chunks: Buffer[] = [head]
  let collected = head.length
  let next = offset + local + 4 <= page.length ? page.readUInt32BE(offset + local) : 0
  const seen = new Set<number>()
  const wanted = Math.min(payloadSize, limit)
  while (next > 0 && collected < wanted && !seen.has(next)) {
    seen.add(next)
    const overflow = await pager.read(next)
    if (!overflow) break
    const slice = overflow.subarray(4, usable)
    chunks.push(slice)
    collected += slice.length
    next = overflow.readUInt32BE(0)
  }
  return Buffer.concat(chunks)
}

function decodeRecord(payload: Buffer): SqliteValue[] {
  const values: SqliteValue[] = []
  const header = readVarint(payload, 0)
  if (header.size === 0 || header.value <= 0) return values
  const headerEnd = Math.min(header.value, payload.length)
  let cursor = header.size
  let body = header.value
  while (cursor < headerEnd) {
    const serial = readVarint(payload, cursor)
    if (serial.size === 0) break
    cursor += serial.size
    const type = serial.value
    const size =
      type === 0 || type === 8 || type === 9
        ? 0
        : type >= 1 && type <= 4
          ? type
          : type === 5
            ? 6
            : type === 6 || type === 7
              ? 8
              : type >= 12
                ? Math.floor((type - 12) / 2)
                : 0
    const start = body
    body += size
    if (start + size > payload.length) {
      // The record was cut short by the payload budget: everything from here
      // on is unknown rather than wrong.
      values.push(null)
      continue
    }
    if (type === 0) values.push(null)
    else if (type === 8) values.push(0)
    else if (type === 9) values.push(1)
    else if (type === 7) values.push(payload.readDoubleBE(start))
    else if (type >= 1 && type <= 6) {
      let int = 0n
      for (let i = 0; i < size; i += 1) int = (int << 8n) | BigInt(payload[start + i])
      const signed = BigInt.asIntN(size * 8, int)
      values.push(
        signed >= BigInt(Number.MIN_SAFE_INTEGER) && signed <= BigInt(Number.MAX_SAFE_INTEGER)
          ? Number(signed)
          : signed
      )
    } else if (type >= 12 && type % 2 === 0) {
      values.push(new Uint8Array(payload.subarray(start, start + size)))
    } else if (type >= 13) {
      values.push(payload.subarray(start, start + size).toString('utf8'))
    } else values.push(null)
  }
  return values
}

/** Every record in one table b-tree. */
async function walkTable(
  pager: Pager,
  root: number,
  options: Required<ReadTableOptions>
): Promise<SqliteValue[][]> {
  const rows: SqliteValue[][] = []
  const seen = new Set<number>()
  const stack = [root]
  let visited = 0
  while (stack.length > 0 && rows.length < options.maxRows && visited < options.maxPages) {
    const pageNo = stack.pop()!
    if (pageNo < 1 || seen.has(pageNo)) continue
    seen.add(pageNo)
    visited += 1
    const page = await pager.read(pageNo)
    if (!page) continue
    const base = pageNo === 1 ? HEADER_BYTES : 0
    if (base + 12 > page.length) continue
    const type = page.readUInt8(base)
    // Index pages carry no table rows, and a page of any other shape is not
    // part of this b-tree.
    if (type !== 0x05 && type !== 0x0d) continue
    const cells = page.readUInt16BE(base + 3)
    const pointers = base + (type === 0x05 ? 12 : 8)
    const children: number[] = []
    if (type === 0x05) {
      const rightmost = page.readUInt32BE(base + 8)
      if (rightmost > 0) children.push(rightmost)
    }
    for (let i = 0; i < cells; i += 1) {
      const pointer = pointers + i * 2
      if (pointer + 2 > page.length) break
      const offset = page.readUInt16BE(pointer)
      if (offset < base || offset >= page.length) continue
      if (type === 0x05) {
        if (offset + 4 <= page.length) children.push(page.readUInt32BE(offset))
        continue
      }
      const size = readVarint(page, offset)
      if (size.size === 0) continue
      const rowid = readVarint(page, offset + size.size)
      if (rowid.size === 0) continue
      const payload = await cellPayload(
        pager,
        page,
        offset + size.size + rowid.size,
        size.value,
        options.maxPayloadBytes
      )
      rows.push(decodeRecord(payload))
      if (rows.length >= options.maxRows) break
    }
    // Reversed, so the stack hands the children back in page order.
    for (let i = children.length - 1; i >= 0; i -= 1) stack.push(children[i])
  }
  return rows
}

/**
 * Column names in declaration order, which is the order a record stores them.
 * Table constraints (`PRIMARY KEY (...)`, `FOREIGN KEY ...`) take no slot in a
 * record, so they are skipped rather than counted.
 */
export function parseColumnNames(sql: string): string[] {
  const open = sql.indexOf('(')
  const close = sql.lastIndexOf(')')
  if (open < 0 || close <= open) return []
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const char of sql.slice(open + 1, close)) {
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    if (char === ',' && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += char
  }
  parts.push(current)

  const constraint = /^(constraint|primary|unique|check|foreign|key)\b/i
  const names: string[] = []
  for (const part of parts) {
    const text = part.trim()
    if (!text) continue
    if (constraint.test(text)) continue
    const named = text.match(/^(?:`([^`]+)`|"([^"]+)"|\[([^\]]+)\]|([A-Za-z_][\w$]*))/)
    // A column we cannot name would shift every later column by one, so give
    // up on the shape instead of mislabelling the row.
    if (!named) return []
    names.push(named[1] ?? named[2] ?? named[3] ?? named[4] ?? '')
  }
  return names
}

/**
 * Every row of `table`, as objects keyed by column name.
 *
 * Returns an empty list for a missing file, an unreadable one, a file that is
 * not a database, or a table that is not in it.
 */
export async function readSqliteTable(
  file: string,
  table: string,
  options: ReadTableOptions = {}
): Promise<SqliteRow[]> {
  const settings: Required<ReadTableOptions> = {
    maxRows: options.maxRows ?? DEFAULTS.maxRows,
    maxPages: options.maxPages ?? DEFAULTS.maxPages,
    maxPayloadBytes: options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes
  }
  const pager = await openPager(file)
  if (!pager) return []
  try {
    // sqlite_master: (type, name, tbl_name, rootpage, sql), rooted at page 1.
    const master = await walkTable(pager, 1, { ...settings, maxRows: 2_000 })
    let root = 0
    let columns: string[] = []
    for (const values of master) {
      if (values[0] !== 'table' || values[1] !== table) continue
      const rootpage = values[3]
      const sql = values[4]
      if (typeof rootpage !== 'number' || typeof sql !== 'string') break
      root = rootpage
      columns = parseColumnNames(sql)
      break
    }
    if (root < 1 || columns.length === 0) return []

    const rows = await walkTable(pager, root, settings)
    return rows.map((values) => {
      const row: SqliteRow = {}
      columns.forEach((name, index) => {
        row[name] = index < values.length ? values[index] : null
      })
      return row
    })
  } catch {
    return []
  } finally {
    await pager.close()
  }
}
