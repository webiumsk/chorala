import { type ComponentChildren, h } from 'preact'

// Original MIT widget renderer. Content stays in escaped Preact text nodes;
// the supported Markdown subset never accepts HTML, embeds, or remote images.
// Link parts exclude nested brackets so malformed openers cannot repeatedly scan
// the remaining input. Unsupported nested syntax stays visible as escaped text.
const inlineTokens =
  /\\[\\`*_[\]{}()!>#.+-]|`[^`\n]+`|!?\[[^[\]\n]+\]\((?:<[^<>[\]\n]+>|[^)[\]\s]+)\)|\*\*[^*\n]+\*\*|__[^_\n]+__|\*[^*\n]+\*|_[^_\n]+_/g

function webLink(destination: string): string | null {
  if (
    !/^https?:\/\//i.test(destination) ||
    /[\s\\]/.test(destination) ||
    Array.from(destination).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  )
    return null
  try {
    const url = new URL(destination)
    return url.hostname && !url.username && !url.password ? url.href : null
  } catch {
    return null
  }
}

function inline(source: string, depth = 0): ComponentChildren[] {
  if (depth >= 8) return [source]
  const children: ComponentChildren[] = []
  let cursor = 0
  for (const match of source.matchAll(inlineTokens)) {
    const start = match.index
    if (start > cursor) children.push(source.slice(cursor, start))
    const token = match[0]
    let child: ComponentChildren = token
    if (token[0] === '\\') child = token.slice(1)
    else if (token[0] === '`') child = h('code', {}, token.slice(1, -1))
    else if (token[0] === '[') {
      const end = token.indexOf('](')
      const raw = token.slice(end + 2, -1)
      const href = webLink(raw.startsWith('<') ? raw.slice(1, -1) : raw)
      if (href)
        child = h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, token.slice(1, end))
    } else if (token.startsWith('**') || token.startsWith('__'))
      child = h('strong', {}, inline(token.slice(2, -2), depth + 1))
    else if (token[0] === '*' || token[0] === '_')
      child = h('em', {}, inline(token.slice(1, -1), depth + 1))
    // Image syntax remains visible text rather than creating an element/request.
    children.push(child)
    cursor = start + token.length
  }
  if (cursor < source.length) children.push(source.slice(cursor))
  return children
}

const headingLine = /^(#{1,6})\s+(.+)$/
const listLine = /^\s*(?:([-+*])|([0-9]+)\.)\s+(.+)$/
const fenceLine = /^\s*(`{3,}|~{3,})[^`~]*$/
const quoteLine = /^\s*>\s?(.*)$/
const ruleLine = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const startsBlock = (line: string) =>
  headingLine.test(line) ||
  listLine.test(line) ||
  fenceLine.test(line) ||
  quoteLine.test(line) ||
  ruleLine.test(line)

export function ChangelogMarkdown({ body }: { body: string }) {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const blocks: ComponentChildren[] = []
  let row = 0
  while (row < lines.length) {
    const line = lines[row] ?? ''
    const key = row
    row++
    if (!line.trim()) continue
    const fence = line.match(fenceLine)
    const heading = line.match(headingLine)
    const list = line.match(listLine)
    const quote = line.match(quoteLine)
    if (fence) {
      const marker = fence[1] ?? '```'
      const close = new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`)
      const code: string[] = []
      while (row < lines.length && !close.test(lines[row] ?? '')) code.push(lines[row++] ?? '')
      if (row < lines.length) row++
      blocks.push(h('pre', { key, tabIndex: 0 }, h('code', {}, code.join('\n'))))
    } else if (heading) {
      const level = Math.min(6, (heading[1]?.length ?? 1) + 2)
      blocks.push(h(`h${level}`, { key }, inline(heading[2] ?? '')))
    } else if (ruleLine.test(line)) blocks.push(h('hr', { key }))
    else if (list) {
      const numbered = Boolean(list[2])
      const items: ComponentChildren[] = [h('li', { key }, inline(list[3] ?? ''))]
      while (row < lines.length) {
        const next = (lines[row] ?? '').match(listLine)
        if (!next || Boolean(next[2]) !== numbered) break
        items.push(h('li', { key: row }, inline(next[3] ?? '')))
        row++
      }
      blocks.push(
        h(numbered ? 'ol' : 'ul', { key, ...(numbered ? { start: Number(list[2]) } : {}) }, items),
      )
    } else if (quote) {
      const text = [quote[1] ?? '']
      while (row < lines.length) {
        const next = (lines[row] ?? '').match(quoteLine)
        if (!next) break
        text.push(next[1] ?? '')
        row++
      }
      blocks.push(h('blockquote', { key }, inline(text.join(' '))))
    } else {
      const text = [line]
      while (row < lines.length && (lines[row] ?? '').trim() && !startsBlock(lines[row] ?? ''))
        text.push(lines[row++] ?? '')
      blocks.push(h('p', { key }, inline(text.join(' '))))
    }
  }
  return h('div', { class: 'chorala-markdown' }, blocks)
}
