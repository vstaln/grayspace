import React from 'react'

/**
 * Renders the small subset of markdown that model replies actually use —
 * headings, ordered/unordered lists, fenced and inline code, bold — as React
 * elements. Built as elements rather than an HTML string on purpose: model
 * output is untrusted text, and `dangerouslySetInnerHTML` would make any
 * stray tag in a reply executable in the renderer.
 */

/** http(s) only — never javascript: or relative app schemes from model text. */
function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.href
  } catch {
    return null
  }
}

function emitOpenNote(title: string): void {
  if (typeof window === 'undefined' || !title) return
  window.dispatchEvent(new CustomEvent('orcspace:open-note', { detail: title }))
}

/** Inline `code`, [[wikilinks]], [links](url), and **bold** within a single line. */
function renderInline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // Inline code is split out first so its contents are never re-parsed as bold/links.
  text.split(/(`[^`\n]+`)/g).forEach((part, i) => {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      out.push(
        <code
          key={`${key}-c${i}`}
          className="rounded border border-line-soft bg-bg-hover px-1 py-[1px] font-mono text-[0.88em] text-text"
        >
          {part.slice(1, -1)}
        </code>
      )
      return
    }
    // Wikilinks and standard links before bold
    part.split(/(\[\[[^\]\n]+\]\]|\[[^\]]+\]\([^)\s]+\))/g).forEach((segment, s) => {
      const wiki = /^\[\[([^\]\n]+)\]\]$/.exec(segment)
      if (wiki) {
        const title = wiki[1].split('|')[0].trim()
        out.push(
          <button
            key={`${key}-w${i}-${s}`}
            type="button"
            className="inline-flex items-center gap-0.5 rounded bg-accent/10 px-1 py-[0.5px] font-medium text-accent hover:bg-accent/20"
            title={`Open note: ${title}`}
            onClick={() => emitOpenNote(title)}
          >
            [[{wiki[1]}]]
          </button>
        )
        return
      }

      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(segment)
      if (link) {
        const href = safeHref(link[2])
        if (href) {
          out.push(
            <a
              key={`${key}-a${i}-${s}`}
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
            >
              {link[1]}
            </a>
          )
          return
        }
        out.push(<React.Fragment key={`${key}-al${i}-${s}`}>{segment}</React.Fragment>)
        return
      }
      segment.split(/(\*\*[^*\n]+\*\*)/g).forEach((chunk, j) => {
        if (!chunk) return
        if (chunk.length > 4 && chunk.startsWith('**') && chunk.endsWith('**')) {
          out.push(
            <strong key={`${key}-b${i}-${s}-${j}`} className="font-semibold text-text">
              {chunk.slice(2, -2)}
            </strong>
          )
        } else {
          // Dollar note references: $Title-With-Hyphens
          chunk.split(/(\$[\p{L}\p{N}_\-]+)/u).forEach((atom, k) => {
            if (atom.startsWith('$') && atom.length > 1) {
              out.push(
                <button
                  key={`${key}-d${i}-${s}-${j}-${k}`}
                  type="button"
                  className="rounded bg-accent/10 px-1 py-[0.5px] font-mono text-[0.9em] text-accent hover:bg-accent/20"
                  title={`Open note: ${atom.slice(1)}`}
                  onClick={() => emitOpenNote(atom.slice(1))}
                >
                  {atom}
                </button>
              )
            } else if (atom) {
              out.push(<React.Fragment key={`${key}-t${i}-${s}-${j}-${k}`}>{atom}</React.Fragment>)
            }
          })
        }
      })
    })
  })
  return out
}

export function Markdown({ text }: { text: string }): React.JSX.Element {
  const blocks: React.ReactNode[] = []
  const lines = String(text ?? '').split('\n')
  let paragraph: string[] = []
  let code: string[] | null = null

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return
    const body = paragraph.join('\n')
    blocks.push(
      <p key={`p${blocks.length}`} className="whitespace-pre-wrap">
        {renderInline(body, `p${blocks.length}`)}
      </p>
    )
    paragraph = []
  }

  for (const line of lines) {
    // Fenced code swallows everything up to the closing fence verbatim.
    if (line.trimStart().startsWith('```')) {
      if (code === null) {
        flushParagraph()
        code = []
      } else {
        blocks.push(
          <pre
            key={`f${blocks.length}`}
            className="overflow-x-auto rounded-xl border border-line-soft bg-bg-raise p-2.5 font-mono text-[11.5px] leading-relaxed text-text-dim"
          >
            {code.join('\n')}
          </pre>
        )
        code = null
      }
      continue
    }
    if (code !== null) {
      code.push(line)
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      flushParagraph()
      const level = heading[1].length as 1 | 2 | 3 | 4
      const sizes: Record<number, string> = {
        1: 'text-[17px]',
        2: 'text-[15.5px]',
        3: 'text-[13.5px]',
        4: 'text-[12.5px]'
      }
      // One tag per level so a `#` title and a `####` subheading keep their
      // hierarchy instead of all rendering as the same `<h3>`.
      const Tag = `h${level}` as React.ElementType
      blocks.push(
        <Tag key={`h${blocks.length}`} className={`pt-1 font-semibold text-text ${sizes[level]}`}>
          {renderInline(heading[2], `h${blocks.length}`)}
        </Tag>
      )
      continue
    }

    const listItem = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (listItem) {
      flushParagraph()
      blocks.push(
        <div key={`l${blocks.length}`} className="flex gap-2 pl-1">
          <span className="flex-none text-text-faint">{listItem[2] ? `${listItem[2]}.` : '•'}</span>
          <span className="min-w-0">{renderInline(listItem[3], `l${blocks.length}`)}</span>
        </div>
      )
      continue
    }

    if (line.trim() === '') flushParagraph()
    else paragraph.push(line)
  }

  // An unterminated fence still has to render, or a streaming reply shows nothing.
  if (code !== null && code.length > 0) {
    blocks.push(
      <pre
        key={`f${blocks.length}`}
        className="overflow-x-auto rounded-xl border border-line-soft bg-bg-raise p-2.5 font-mono text-[11.5px] leading-relaxed text-text-dim"
      >
        {code.join('\n')}
      </pre>
    )
  }
  flushParagraph()

  return <div className="flex flex-col gap-2.5">{blocks}</div>
}
