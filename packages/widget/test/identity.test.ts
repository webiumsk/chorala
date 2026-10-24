import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Api } from '../src/api.ts'

const lifecycle = vi.hoisted(() => ({ mount: vi.fn() }))
vi.mock('../src/mount.tsx', () => ({ mountWidget: lifecycle.mount }))

type WidgetCommand = ((name: string, ...args: unknown[]) => void) & {
  supportsIdentityRefresh?: boolean
}

describe('widget identity lifecycle', () => {
  const containers = new Map<string, Element>()
  const mounted: Array<{ api: Api; destroy: ReturnType<typeof vi.fn>; mode: string }> = []
  const fetchMock = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    containers.clear()
    mounted.length = 0
    lifecycle.mount.mockImplementation((options: { api: Api; mode: string }) => {
      const instance = { open: vi.fn(), close: vi.fn(), destroy: vi.fn() }
      mounted.push({ ...options, destroy: instance.destroy })
      return instance
    })
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('window', {})
    vi.stubGlobal('navigator', { language: 'en' })
    vi.stubGlobal('location', { origin: 'https://client.example' })
    vi.stubGlobal('document', {
      currentScript: null,
      getElementsByTagName: () => [],
      querySelector: (selector: string) => containers.get(selector) ?? null,
    })
  })

  afterEach(() => vi.unstubAllGlobals())

  async function load() {
    await import('../src/index.tsx')
    return (window as unknown as { Chorala: WidgetCommand }).Chorala
  }

  it('rotates the identity header for all mounted views without replacing their state', async () => {
    const run = await load()
    containers.set('#inline', { isConnected: true } as Element)
    run('init', { projectKey: 'project-a', user: { jwt: 'old-token' } })
    run('render', '#inline', { view: 'roadmap' })
    expect(run.supportsIdentityRefresh).toBe(true)
    const [floating, inline] = mounted
    expect(floating?.api).toBe(inline?.api)
    await floating?.api.getPost('post-a')
    expect(fetchMock.mock.lastCall?.[1].headers['x-chorala-user']).toBe('old-token')

    run('refreshIdentity', { jwt: 'renewed-token' })
    expect(lifecycle.mount).toHaveBeenCalledTimes(2)
    expect(floating?.destroy).not.toHaveBeenCalled()
    expect(inline?.destroy).not.toHaveBeenCalled()
    await inline?.api.comment('post-a', 'synthetic retained draft')
    expect(fetchMock.mock.lastCall?.[1].headers['x-chorala-user']).toBe('renewed-token')

    run('refreshIdentity', {})
    await floating?.api.getPost('post-a')
    expect(fetchMock.mock.lastCall?.[1].headers).not.toHaveProperty('x-chorala-user')
    expect(lifecycle.mount).toHaveBeenCalledTimes(2)
  })

  it('destroys floating and inline account state on identify, including logout', async () => {
    const run = await load()
    containers.set('#inline', { isConnected: true } as Element)
    run('init', { projectKey: 'project-a', user: { jwt: 'account-a' } })
    run('render', '#inline')
    const original = [...mounted]
    run('identify', { jwt: 'account-b' })
    for (const previous of original) expect(previous.destroy).toHaveBeenCalledOnce()
    expect(lifecycle.mount).toHaveBeenCalledTimes(4)
    await mounted[3]?.api.getPost('post-a')
    expect(fetchMock.mock.lastCall?.[1].headers['x-chorala-user']).toBe('account-b')
    const identified = mounted.slice(2)
    run('identify', {})
    for (const previous of identified) expect(previous.destroy).toHaveBeenCalledOnce()
    await mounted[5]?.api.getPost('post-a')
    expect(fetchMock.mock.lastCall?.[1].headers).not.toHaveProperty('x-chorala-user')
  })

  it('clears all previous project instances on reinitialization', async () => {
    const run = await load()
    containers.set('#inline', { isConnected: true } as Element)
    run('init', { projectKey: 'project-a' })
    run('render', '#inline')
    const original = [...mounted]
    run('init', { projectKey: 'project-b', settings: { mode: 'inline' } })
    for (const previous of original) expect(previous.destroy).toHaveBeenCalledOnce()
    expect(lifecycle.mount).toHaveBeenCalledTimes(2)
    run('render', '#inline')
    await mounted[2]?.api.getPost('post-b')
    expect(fetchMock.mock.lastCall?.[1].headers['x-chorala-key']).toBe('project-b')
  })

  it('replaces an inline render in the same container instead of retaining an old account view', async () => {
    const run = await load()
    containers.set('#inline', { isConnected: true } as Element)
    run('init', { projectKey: 'project-a', settings: { mode: 'inline' } })
    run('render', '#inline')
    run('render', '#inline', { view: 'changelog' })
    expect(mounted[0]?.destroy).toHaveBeenCalledOnce()
    expect(lifecycle.mount).toHaveBeenCalledTimes(2)
  })
})
