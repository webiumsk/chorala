# @chorala/widget

MIT-licensed Preact widget, distributed as a standalone `dist/widget.js` bundle.
Its Shadow DOM keeps the widget's light/dark styles separate from the host page.

## Changelog formatting

Changelog bodies support paragraphs, headings, ordered and unordered lists,
bold and italic text, inline and fenced code, quotes, dividers and labelled
HTTP(S) links, including `[label](<https://example.com>)`. Links open in a new tab
with `noopener noreferrer`. Raw HTML, images and unsupported links remain text.
This is a small Markdown subset, not a full CommonMark renderer.

Rendering is implemented inside this MIT package without importing AGPL dashboard
or server code. Existing stored Markdown and publication dates need no migration.

```sh
pnpm --filter @chorala/widget test
pnpm --filter @chorala/widget typecheck
pnpm --filter @chorala/widget build
```

Applications that vendor the widget, including Satflux, must update their pinned
browser artifact and rebuild their frontend to receive widget fixes. Updating the
Chorala server alone does not replace an application's bundled widget.
