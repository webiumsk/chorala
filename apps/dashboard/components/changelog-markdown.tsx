import React, { type ReactNode } from 'react'

/** Render a small, safe Markdown subset without HTML or remote image loading. */
function inlineMarkdown(text: string): ReactNode[] {
  const parts: ReactNode[] = []
  const tokens = /`[^`\n]+`|\*\*[^*\n]+\*\*|\[[^\]\n]+\]\((?:<[^>\n]+>|[^)\s]+)\)/g
  let offset = 0
  for (const match of text.matchAll(tokens)) {
    if (match.index > offset) parts.push(text.slice(offset, match.index))
    const token = match[0]
    const key = match.index
    if (token.startsWith('`')) {
      parts.push(
        <code key={key} className="rounded bg-ink/5 px-1 py-0.5 text-[0.9em]">
          {token.slice(1, -1)}
        </code>,
      )
    } else if (token.startsWith('**')) {
      parts.push(<strong key={key}>{token.slice(2, -2)}</strong>)
    } else {
      const link = token.match(/^\[([^\]\n]+)\]\((?:<([^>\n]+)>|([^)\s]+))\)$/)
      let url: URL | null = null
      try {
        const candidate = new URL(link?.[2] ?? link?.[3] ?? '')
        if (
          ['http:', 'https:'].includes(candidate.protocol) &&
          !candidate.username &&
          !candidate.password
        )
          url = candidate
      } catch {
        // Invalid, relative and non-web links remain escaped text.
      }
      parts.push(
        url ? (
          <a
            key={key}
            href={url.href}
            target="_blank"
            rel="noopener noreferrer"
            className="break-words text-accent underline underline-offset-2"
          >
            {link?.[1]}
          </a>
        ) : (
          token
        ),
      )
    }
    offset = match.index + token.length
  }
  if (offset < text.length) parts.push(text.slice(offset))
  return parts
}

const isBlockStart = (line: string) =>
  /^(?:#{1,6}\s|```|\s*[-*+]\s|\s*\d+\.\s|>\s?|---+$)/.test(line)

export function ChangelogMarkdown({ body }: { body: string }) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i] ?? ''
    const key = i
    if (!line.trim()) {
      i++
      continue
    }
    if (line.startsWith('```')) {
      const code: string[] = []
      i++
      while (i < lines.length && !lines[i]?.startsWith('```')) code.push(lines[i++] ?? '')
      if (i < lines.length) i++
      blocks.push(
        <pre key={key} className="overflow-x-auto rounded-lg bg-ink/5 p-3 text-xs">
          <code>{code.join('\n')}</code>
        </pre>,
      )
      continue
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/)
    if (heading) {
      const Heading = `h${Math.min((heading[1]?.length ?? 1) + 2, 6)}` as 'h3' | 'h4' | 'h5' | 'h6'
      blocks.push(
        <Heading key={key} className="font-semibold text-ink">
          {inlineMarkdown(heading[2] ?? '')}
        </Heading>,
      )
      i++
      continue
    }
    if (/^---+$/.test(line)) {
      blocks.push(<hr key={key} className="border-line" />)
      i++
      continue
    }
    const unordered = /^\s*[-*+]\s+(.+)$/
    const ordered = /^\s*\d+\.\s+(.+)$/
    if (unordered.test(line) || ordered.test(line)) {
      const pattern = unordered.test(line) ? unordered : ordered
      const List = pattern === unordered ? 'ul' : 'ol'
      const items: ReactNode[] = []
      while (i < lines.length) {
        const item = lines[i]?.match(pattern)
        if (!item) break
        items.push(<li key={i}>{inlineMarkdown(item[1] ?? '')}</li>)
        i++
      }
      blocks.push(
        <List
          key={key}
          className={`${List === 'ul' ? 'list-disc' : 'list-decimal'} space-y-1 pl-5`}
        >
          {items}
        </List>,
      )
      continue
    }
    if (line.startsWith('>')) {
      const quote: string[] = []
      while (i < lines.length && lines[i]?.startsWith('>'))
        quote.push((lines[i++] ?? '').replace(/^>\s?/, ''))
      blocks.push(
        <blockquote key={key} className="border-l-2 border-line-strong pl-3 text-ink-soft">
          {inlineMarkdown(quote.join(' '))}
        </blockquote>,
      )
      continue
    }
    const paragraph = [line]
    i++
    while (i < lines.length && lines[i]?.trim() && !isBlockStart(lines[i] ?? ''))
      paragraph.push(lines[i++] ?? '')
    blocks.push(<p key={key}>{inlineMarkdown(paragraph.join(' '))}</p>)
  }
  return React.createElement(
    'div',
    { className: 'space-y-3 break-words text-sm leading-relaxed' },
    blocks,
  )
}
