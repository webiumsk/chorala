import { afterEach, describe, expect, it, vi } from 'vitest'
import { collectContext, contextOrigin } from '../src/context.ts'

describe('privacy-aware diagnostic context', () => {
  afterEach(() => vi.unstubAllGlobals())

  it.each([
    'https://merchant.example/wallets/private-id?token=synthetic-secret#recovery',
    'https://merchant.example/account/recovery/synthetic-secret',
    'https://merchant.example/stores/merchant-id/invoices/private-id',
    'https://name:synthetic-secret@merchant.example/anything?key=value',
  ])('keeps only the origin of %s', (url) => {
    expect(contextOrigin(url)).toBe('https://merchant.example')
  })

  it.each(['', 'not a URL', 'data:text/html,private', 'javascript:alert(1)', 'file:///private'])(
    'omits non-HTTP context %s',
    (url) => expect(contextOrigin(url)).toBeUndefined(),
  )

  it('retains useful browser context without page or referrer credentials', () => {
    vi.stubGlobal('navigator', { userAgent: 'Mozilla/5.0 Firefox/120.0 Linux', language: 'sk-SK' })
    vi.stubGlobal('location', {
      href: 'https://client.example/wallet/recovery?token=secret#phrase',
    })
    vi.stubGlobal('document', { referrer: 'https://other.example/account/private?email=private' })
    vi.stubGlobal('window', { innerWidth: 1024, innerHeight: 768, devicePixelRatio: 2 })
    vi.stubGlobal('screen', { width: 1920, height: 1080 })
    const context = collectContext()
    expect(context.url).toBe('https://client.example')
    expect(context.referrer).toBe('https://other.example')
    expect(context.locale).toBe('sk-SK')
    expect(context.browser).toBe('Firefox 120.0')
    expect(context.viewport).toBe('1024×768')
    expect(JSON.stringify(context)).not.toMatch(/secret|phrase|private|recovery/)
  })
})
