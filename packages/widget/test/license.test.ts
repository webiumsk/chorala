import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import config from '../tsup.config.ts'

describe('standalone widget distribution notices', () => {
  it('includes the complete package and bundled Preact licenses in the generated banner', () => {
    const require = createRequire(import.meta.url)
    const widgetLicense = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8')
    const preactLicense = readFileSync(
      join(dirname(require.resolve('preact/package.json')), 'LICENSE'),
      'utf8',
    )
    expect(config.banner?.js).toContain(widgetLicense)
    expect(config.banner?.js).toContain(preactLicense)
  })
})
