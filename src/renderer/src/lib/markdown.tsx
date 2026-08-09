import React from 'react'

/**
 * Renders the small subset of markdown that model replies actually use —
 * headings, ordered/unordered lists, fenced and inline code, bold — as React
 * elements. Built as elements rather than an HTML string on purpose: model
 * output is untrusted text, and `dangerouslySetInnerHTML` would make any
 * stray tag in a reply executable in the renderer.
 */

/** Inline `code` and **bold** within a single line. */
function renderInline(text: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = []
  // Inline code is split out first so its contents are never re-parsed as bold.
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
    part.split(/(\*\*[^*\n]+\*\*)/g).forEach((chunk, j) => {
      if (!chunk) return
      if (chunk.length > 4 && chunk.startsWith('**') && chunk.endsWith('**')) {
        out.push(
          <strong key={`${key}-b${i}-${j}`} className="font-semibold text-white">
            {chunk.slice(2, -2)}
          </strong>
        )
      } else {
        out.push(<React.Fragment key={`${key}-t${i}-${j}`}>{chunk}</React.Fragment>)
      }
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
      blocks.push(
        <h3 key={`h${blocks.length}`} className="pt-1 text-[13.5px] font-semibold text-white">
          {renderInline(heading[2], `h${blocks.length}`)}
        </h3>
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
