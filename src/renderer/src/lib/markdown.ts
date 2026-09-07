/**
 * Minimal markdown utilities for notes and previews.
 * Sanitizes URLs against javascript: and other dangerous protocols.
 */

import { sanitizeUrl, linkTargetFor } from './sanitizeUrl.ts'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function encodeAutolink(raw: string): string {
  const trimmed = raw.trim()
  // `<url>` may contain raw spaces during typing/streaming — encode them so
  // the href stays valid without breaking already-encoded sequences.
  try {
    return encodeURI(trimmed).replace(/%20/g, '%20')
  } catch {
    return trimmed.replace(/\s+/g, '%20')
  }
}

/**
 * Renders markdown links and images with sanitized URLs.
 * Unsafe URLs are rendered as plain text (links) or alt text only (images).
 */
export function renderMarkdownInlineLinks(markdown: string): string {
  if (!markdown) return ''
  // Autolinks `<https://…>` / `<mailto:…>` first (may contain spaces → encode).
  // Use placeholders so the main link pass doesn't double-process them.
  const autolinks: string[] = []
  const withAutolinks = markdown.replace(/<((https?:\/\/|mailto:|tel:)[^<>]*)>/g, (full, raw: string) => {
    const encoded = encodeAutolink(raw)
    const safe = sanitizeUrl(encoded, null)
    let html: string
    if (!safe) {
      html = escapeHtml(raw.trim())
    } else {
      const target = linkTargetFor(safe)
      const targetAttr = target ? ` target="${target}"` : ''
      html =
        `<a href="${escapeHtml(safe)}"${targetAttr} rel="noreferrer noopener" style="overflow-wrap:anywhere">${escapeHtml(raw.trim())}</a>`
    }
    autolinks.push(html)
    return `\u0000AUTOLINK${autolinks.length - 1}\u0000`
  })

  // We'll walk the string and replace links/images with sanitized HTML,
  // escaping all other text.
  let result = ''
  let lastIndex = 0
  const combined = /!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g
  let m: RegExpExecArray | null
  while ((m = combined.exec(withAutolinks)) !== null) {
    const textBefore = withAutolinks.slice(lastIndex, m.index)
    result += escapeHtml(textBefore)
    if (m[1] !== undefined) {
      // Image: ![alt](url)
      const alt = m[1]
      const url = m[2].trim()
      const safe = sanitizeUrl(url, null)
      if (!safe) {
        result += escapeHtml(alt)
      } else {
        result += `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy" style="max-width:100%" />`
      }
    } else {
      // Link: [text](url) — same decode-aware gate as images so encoded
      // payloads (javascript%3A…) get identical treatment in both branches.
      const text = m[3]
      const url = m[4].trim()
      const safe = sanitizeUrl(url, null)
      if (!safe) {
        result += escapeHtml(text)
      } else {
        const target = linkTargetFor(safe)
        const targetAttr = target ? ` target="${target}"` : ''
        result += `<a href="${escapeHtml(safe)}"${targetAttr} rel="noreferrer noopener" style="overflow-wrap:anywhere">${escapeHtml(text)}</a>`
      }
    }
    lastIndex = m.index + m[0].length
  }
  result += escapeHtml(withAutolinks.slice(lastIndex))
  // Restore autolink placeholders (already-HTML, must not be escaped).
  result = result.replace(/\u0000AUTOLINK(\d+)\u0000/g, (_, idx: string) => autolinks[Number(idx)] ?? '')
  return result
}

/** Extract fenced ``` blocks (incl. unclosed trailing fence during streaming). */
function extractFenced(markdown: string): { text: string; blocks: string[] } {
  const blocks: string[] = []
  // ```lang?\n … ```  OR  ```lang?\n … (EOF, unclosed)
  const text = markdown.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, (full, lang: string, code: string) => {
    const idx = blocks.length
    const safeLang = escapeHtml((lang || '').trim())
    const label = safeLang ? ` data-lang="${safeLang}"` : ''
    blocks.push(
      `<pre${label} style="max-width:100%;overflow-x:auto"><code style="overflow-wrap:anywhere">${escapeHtml(code.replace(/\n$/, ''))}</code></pre>`
    )
    return `\u0000FENCED${idx}\u0000`
  })
  return { text, blocks }
}

function restoreFenced(html: string, blocks: string[]): string {
  return html.replace(/\u0000FENCED(\d+)\u0000/g, (_, idx: string) => blocks[Number(idx)] ?? '')
}

/** True when a line is a markdown table delimiter (`| --- | --- |`). */
function isDelimiterRow(line: string): boolean {
  const cells = line.trim().replace(/^\||\|$/g, '').split('|')
  if (cells.length === 0) return false
  return cells.every((c) => /^[\s:|-]*-+[\s:|-]*$/.test(c))
}

function containsPipe(line: string): boolean {
  return line.includes('|')
}

/**
 * Renders pipe tables as <table> inside a horizontal-scroll wrapper so wide
 * tables never blow out the preview pane.
 */
function renderTables(markdown: string): { text: string; tables: string[] } {
  const tables: string[] = []
  const lines = markdown.split('\n')
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const header = lines[i]
    const delimiter = lines[i + 1]
    if (header !== undefined && delimiter !== undefined && containsPipe(header) && isDelimiterRow(delimiter)) {
      const headerCells = header.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim())
      const rows: string[][] = []
      let j = i + 2
      while (j < lines.length && containsPipe(lines[j]) && lines[j].trim() !== '') {
        rows.push(lines[j].trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
        j += 1
      }
      const idx = tables.length
      let table = `<div style="max-width:100%;overflow-x:auto"><table><thead><tr>`
      for (const cell of headerCells) table += `<th>${renderMarkdownInlineLinks(cell)}</th>`
      table += `</tr></thead><tbody>`
      for (const row of rows) {
        table += `<tr>`
        for (let k = 0; k < headerCells.length; k++) table += `<td>${renderMarkdownInlineLinks(row[k] ?? '')}</td>`
        table += `</tr>`
      }
      table += `</tbody></table></div>`
      tables.push(table)
      out.push(`\u0000TABLE${idx}\u0000`)
      i = j
    } else {
      out.push(header)
      i += 1
    }
  }
  return { text: out.join('\n'), tables }
}

function restoreTables(html: string, tables: string[]): string {
  return html.replace(/\u0000TABLE(\d+)\u0000/g, (_, idx: string) => tables[Number(idx)] ?? '')
}

/**
 * Full markdown safe render for preview panes.
 * Handles bold, italic, code, links, images with URL sanitization.
 * Keeps output limited to safe tags only: <strong>, <em>, <code>, <a>, <img>, <br>
 */
export function renderMarkdownSafe(markdown: string): string {
  if (!markdown) return ''
  // Fenced blocks first so their contents never hit link/bold parsing.
  const { text: withoutFenced, blocks } = extractFenced(markdown)
  const { text: withoutTables, tables } = renderTables(withoutFenced)
  // First, handle inline links/images with sanitization
  let html = renderMarkdownInlineLinks(withoutTables)

  // Handle code spans first so bold/italic inside `code` is not parsed.
  const outer = html.split(/(<a[^>]*>.*?<\/a>|<img[^>]*\/?>|\u0000FENCED\d+\u0000|\u0000TABLE\d+\u0000)/g)
  const out: string[] = []
  for (const chunk of outer) {
    if (/^<a/i.test(chunk) || /^<img/i.test(chunk) || /^\u0000(FENCED|TABLE)\d+\u0000$/.test(chunk)) { out.push(chunk); continue }
    const withCode = chunk.replace(/`([^`\n]+)`/g, '<code style="overflow-wrap:anywhere">$1</code>')
    const inner = withCode.split(/(<code[^>]*>.*?<\/code>)/g)
    for (let k = 0; k < inner.length; k++) {
      if (/^<code/i.test(inner[k])) { out.push(inner[k]); continue }
      out.push(inner[k]
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
        .replace(/_([^_\n]+)_/g, '<em>$1</em>'))
    }
  }
  const parts = out
  let joined = parts.join('').replace(/\n/g, '<br />')
  joined = restoreTables(joined, tables)
  joined = restoreFenced(joined, blocks)
  // Placeholders were HTML-escaped when they sat inside text chunks — unescape them.
  joined = joined.replace(/\u0000AUTOLINK(\d+)\u0000/g, (_, idx: string) => {
    // Autolinks were already restored inside renderMarkdownInlineLinks; this
    // is only a safety net for paths that re-escaped them.
    return _
  })
  return joined
}

/** Extracts sanitized hrefs for testing */
export function extractSafeLinks(markdown: string): string[] {
  const urls: string[] = []
  const linkRe = /\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(markdown)) !== null) {
    const url = m[2].trim()
    const safe = sanitizeUrl(url, null)
    if (safe) urls.push(safe)
  }
  // Include `<url>` autolinks (encode spaces first, like the renderer).
  const autoRe = /<((https?:\/\/|mailto:|tel:)[^<>]*)>/g
  while ((m = autoRe.exec(markdown)) !== null) {
    const safe = sanitizeUrl(encodeAutolink(m[1]), null)
    if (safe) urls.push(safe)
  }
  return urls
}
