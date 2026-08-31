/**
 * Minimal markdown utilities for notes and previews.
 * Sanitizes URLs against javascript: and other dangerous protocols.
 */

import { isSafeUrl, sanitizeUrl } from './sanitizeUrl.ts'

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Renders markdown links and images with sanitized URLs.
 * Unsafe URLs are rendered as plain text (links) or alt text only (images).
 */
export function renderMarkdownInlineLinks(markdown: string): string {
  if (!markdown) return ''
  // We'll walk the string and replace links/images with sanitized HTML,
  // escaping all other text.
  let result = ''
  let lastIndex = 0
  const combined = /!\[([^\]]*)\]\(((?:[^\s()]|\([^\s()]*\))+)\)|\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g
  let m: RegExpExecArray | null
  while ((m = combined.exec(markdown)) !== null) {
    const textBefore = markdown.slice(lastIndex, m.index)
    result += escapeHtml(textBefore)
    if (m[1] !== undefined) {
      // Image: ![alt](url)
      const alt = m[1]
      const url = m[2].trim()
      const safe = sanitizeUrl(url, null)
      if (!safe) {
        result += escapeHtml(alt)
      } else {
        result += `<img src="${escapeHtml(safe)}" alt="${escapeHtml(alt)}" loading="lazy" />`
      }
    } else {
      // Link: [text](url)
      const text = m[3]
      const url = m[4].trim()
      if (!isSafeUrl(url)) {
        result += escapeHtml(text)
      } else {
        result += `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer noopener">${escapeHtml(text)}</a>`
      }
    }
    lastIndex = m.index + m[0].length
  }
  result += escapeHtml(markdown.slice(lastIndex))
  return result
}

/**
 * Full markdown safe render for preview panes.
 * Handles bold, italic, code, links, images with URL sanitization.
 * Keeps output limited to safe tags only: <strong>, <em>, <code>, <a>, <img>, <br>
 */
export function renderMarkdownSafe(markdown: string): string {
  if (!markdown) return ''
  // First, handle inline links/images with sanitization
  let html = renderMarkdownInlineLinks(markdown)

  // Now handle bold/italic/code outside of <a> and <img> tags
  const parts = html.split(/(<a[^>]*>.*?<\/a>|<img[^>]*\/?>)/g)
  for (let i = 0; i < parts.length; i++) {
    if (/^<a/i.test(parts[i]) || /^<img/i.test(parts[i])) continue
    parts[i] = parts[i]
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>')
      .replace(/_([^_\n]+)_/g, '<em>$1</em>')
      .replace(/`([^`\n]+)`/g, '<code>$1</code>')
  }
  return parts.join('').replace(/\n/g, '<br />')
}

/** Extracts sanitized hrefs for testing */
export function extractSafeLinks(markdown: string): string[] {
  const urls: string[] = []
  const linkRe = /\[([^\]]+)\]\(((?:[^\s()]|\([^\s()]*\))+)\)/g
  let m: RegExpExecArray | null
  while ((m = linkRe.exec(markdown)) !== null) {
    const url = m[2].trim()
    if (isSafeUrl(url)) urls.push(url)
  }
  return urls
}
