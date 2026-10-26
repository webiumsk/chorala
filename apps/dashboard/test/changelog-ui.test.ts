import assert from 'node:assert/strict'
import { test } from 'node:test'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChangelogMarkdown } from '../components/changelog-markdown.tsx'

const render = (body: string) =>
  renderToStaticMarkup(React.createElement(ChangelogMarkdown, { body }))

test('renders imported headings, lists, inline code and original-source links', () => {
  const html = render(
    '## Fixes\n\n- Fixed **drafts** with `code`.\n\n[Original changelog](<https://github.com/webiumsk/satflux/pulls>)',
  )
  assert.match(html, /<h4[^>]*>Fixes<\/h4>/)
  assert.match(html, /<ul[^>]*><li>Fixed <strong>drafts<\/strong>/)
  assert.match(html, /<code[^>]*>code<\/code>/)
  assert.match(html, /href="https:\/\/github.com\/webiumsk\/satflux\/pulls"/)
  assert.match(html, /rel="noopener noreferrer"/)
})

test('raw HTML and fenced code remain escaped, without loading images', () => {
  const html = render(
    '<script>alert(1)</script>\n\n![image](https://example.test/image.png)\n\n```html\n<img src=x onerror=alert(1)>\n```',
  )
  assert.doesNotMatch(html, /<(script|img)\b/)
  assert.match(html, /&lt;script&gt;/)
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/)
})

test('only absolute web links without embedded credentials become anchors', () => {
  for (const url of [
    'javascript:alert',
    'data:text/html,test',
    '/admin',
    'https://user:password@example.test',
  ]) {
    assert.doesNotMatch(render(`[unsafe](${url})`), /<a\b/)
  }
  assert.match(render('[safe](https://example.test/path)'), /<a\b/)
})

test('ordered lists, quotes, line endings and unterminated code are safe', () => {
  const html = render('1. First\r\n2. Second\r\n\r\n> Quote\r\n\r\n```\r\n<script>')
  assert.match(html, /<ol\b/)
  assert.match(html, /<blockquote\b/)
  assert.match(html, /&lt;script&gt;/)
  assert.doesNotMatch(html, /<script\b/)
})
