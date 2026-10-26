import { describe, expect, it } from 'vitest'
import { ChangelogMarkdown } from '../src/changelog-markdown.tsx'

type Element = { type: unknown; props: Record<string, unknown> }

function elements(value: unknown): Element[] {
  if (Array.isArray(value)) return value.flatMap(elements)
  if (value && typeof value === 'object' && 'type' in value && 'props' in value) {
    const node = value as Element
    return [node, ...elements(node.props.children)]
  }
  return []
}

function text(value: unknown): string {
  if (Array.isArray(value)) return value.map(text).join('')
  if (value && typeof value === 'object' && 'props' in value)
    return text((value as Element).props.children)
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function render(body: string) {
  const root = ChangelogMarkdown({ body })
  return { root, nodes: elements(root), content: text(root) }
}

const find = (nodes: Element[], tag: string) => nodes.filter((node) => node.type === tag)

describe('widget changelog Markdown', () => {
  it('renders imported PR history into headings, lists and labelled links', () => {
    const body = [
      'Development changes merged on 2026-10-24 (UTC).',
      '',
      '## Fixes',
      '- Deferred wallet detection. ([#399](https://github.com/webiumsk/satflux/pull/399))',
      '- Restored **direct feedback** submission.',
      '',
      '[Original changelog](<https://github.com/webiumsk/satflux/pulls>)',
    ].join('\n')
    const { nodes, content } = render(body)
    expect(find(nodes, 'h4').map(text)).toEqual(['Fixes'])
    expect(find(nodes, 'li')).toHaveLength(2)
    expect(find(nodes, 'strong').map(text)).toEqual(['direct feedback'])
    expect(find(nodes, 'a').map((node) => [text(node), node.props.href])).toEqual([
      ['#399', 'https://github.com/webiumsk/satflux/pull/399'],
      ['Original changelog', 'https://github.com/webiumsk/satflux/pulls'],
    ])
    expect(content).not.toContain('##')
    expect(content).not.toContain('[#399]')
    expect(content).toContain('Development changes merged on 2026-10-24 (UTC).')
  })

  it('preserves paragraphs and soft wrapping across CRLF input', () => {
    const { nodes } = render('First line\r\ncontinues here.\r\n\r\nSecond paragraph.')
    expect(find(nodes, 'p').map(text)).toEqual(['First line continues here.', 'Second paragraph.'])
  })

  it('uses ordered-list numbering and keeps adjacent list kinds distinct', () => {
    const { nodes } = render('3. Third step\n4. Fourth step\n- A separate list\n+ Another item')
    expect(find(nodes, 'ol')[0]?.props.start).toBe(3)
    expect(find(nodes, 'ol')).toHaveLength(1)
    expect(find(nodes, 'ul')).toHaveLength(1)
    expect(find(nodes, 'li').map(text)).toEqual([
      'Third step',
      'Fourth step',
      'A separate list',
      'Another item',
    ])
  })

  it('supports emphasis, strong text and literal inline code without evaluating it', () => {
    const { nodes } = render(
      'Use **bold**, __strong__, *italic*, _emphasis_ and `<script>code</script>`.',
    )
    expect(find(nodes, 'strong').map(text)).toEqual(['bold', 'strong'])
    expect(find(nodes, 'em').map(text)).toEqual(['italic', 'emphasis'])
    expect(find(nodes, 'code').map(text)).toEqual(['<script>code</script>'])
    expect(find(nodes, 'script')).toHaveLength(0)
  })

  it('keeps code fences literal and keyboard-scrollable', () => {
    const { nodes } = render(
      '```html\n<script>not executed</script>\n**not bold**\n```\n\nAfter code.',
    )
    expect(find(nodes, 'pre')[0]?.props.tabIndex).toBe(0)
    expect(find(nodes, 'code').map(text)).toEqual(['<script>not executed</script>\n**not bold**'])
    expect(find(nodes, 'strong')).toHaveLength(0)
    expect(find(nodes, 'p').map(text)).toEqual(['After code.'])
  })

  it('supports tilde and unclosed code fences without losing text', () => {
    expect(find(render('~~~txt\nplain\n~~~').nodes, 'code').map(text)).toEqual(['plain'])
    expect(find(render('```\nstill code').nodes, 'code').map(text)).toEqual(['still code'])
  })

  it('keeps quoted text and dividers as semantic elements', () => {
    const { nodes } = render('> First quote\n> continued\n\n---\n\n## Next')
    expect(find(nodes, 'blockquote').map(text)).toEqual(['First quote continued'])
    expect(find(nodes, 'hr')).toHaveLength(1)
    expect(find(nodes, 'h4').map(text)).toEqual(['Next'])
  })

  it('keeps escaped Markdown punctuation literal', () => {
    const { nodes, content } = render('Show \\*literal\\* and \\[not a link\\].')
    expect(find(nodes, 'em')).toHaveLength(0)
    expect(find(nodes, 'a')).toHaveLength(0)
    expect(content).toBe('Show *literal* and [not a link].')
  })

  it.each(['https://example.com/path?x=1&y=2#part', 'http://example.com/', 'HTTPS://example.com/'])(
    'allows explicit web links and isolates the new tab: %s',
    (url) => {
      const { nodes } = render(`[Read more](${url})`)
      const link = find(nodes, 'a')[0]
      expect(link?.props).toMatchObject({
        href: new URL(url).href,
        target: '_blank',
        rel: 'noopener noreferrer',
      })
    },
  )

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//example.com/path',
    '/relative-path',
    'https://name:password@example.com/',
    'https://name@example.com/',
    'https://',
    'https:\\example.com',
    '&#106;avascript:alert(1)',
    'https://example.com/\u0001path',
    'https://example.com/\u007fpath',
    'https://example.com/\tpath',
  ])('keeps unsafe or unsupported URL syntax inert: %s', (url) => {
    const { nodes } = render(`[Unsafe](<${url}>)`)
    expect(find(nodes, 'a')).toHaveLength(0)
  })

  it('never turns HTML, Markdown images or embedded handlers into active elements', () => {
    const body =
      '<img src="https://tracker.example/a" onerror="alert(1)">\n\n![tracking](https://tracker.example/b)\n\n<script>alert(2)</script>'
    const { nodes, content } = render(body)
    expect(find(nodes, 'img')).toHaveLength(0)
    expect(find(nodes, 'script')).toHaveLength(0)
    expect(find(nodes, 'a')).toHaveLength(0)
    expect(content).toContain('<img src="https://tracker.example/a" onerror="alert(1)">')
    expect(content).toContain('![tracking](https://tracker.example/b)')
    for (const node of nodes) {
      expect(node.props).not.toHaveProperty('dangerouslySetInnerHTML')
      expect(Object.keys(node.props).some((key) => /^on/i.test(key))).toBe(false)
    }
  })

  it.each(['[', '![', '[x](', '[x](<', '[x](https://'])(
    'handles large malformed link input without dropping text: %s',
    (opener) => {
      const body = opener.repeat(12_000)
      const { nodes, content } = render(body)
      expect(find(nodes, 'a')).toHaveLength(0)
      expect(content).toBe(body)
    },
  )

  it('handles empty and malformed Markdown as readable text', () => {
    expect(render('').content).toBe('')
    expect(render('**unfinished [broken]( link').content).toBe('**unfinished [broken]( link')
  })
})
