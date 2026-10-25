import { type Api, createApi } from './api.ts'
import { resolveLocale } from './i18n.ts'
import { type Instance, mountWidget } from './mount.tsx'
import type { InitOptions, Mode, View, WidgetSettings } from './types.ts'

type Cmd = [string, ...unknown[]]
type EventCb = (payload?: unknown) => void

const listeners: Record<string, EventCb[]> = {}
let config: InitOptions | null = null
let instance: Instance | null = null
let ctx: { api: Api; locale: string; settings: WidgetSettings } | null = null
const inlineInstances = new Map<Element, { instance: Instance; view: View }>()

/** Clear every mounted account-bound view, including explicit inline renders. */
function destroyInstances() {
  instance?.destroy()
  instance = null
  for (const mounted of inlineInstances.values()) mounted.instance.destroy()
  inlineInstances.clear()
}

function renderInline(container: Element, view: View) {
  if (!ctx) return
  inlineInstances.get(container)?.instance.destroy()
  const mounted = mountWidget({
    api: ctx.api,
    locale: ctx.locale,
    settings: ctx.settings,
    mode: 'inline',
    defaultView: view,
    container,
  })
  inlineInstances.set(container, { instance: mounted, view })
}

function emit(event: string, payload?: unknown) {
  for (const cb of listeners[event] ?? []) cb(payload)
}

/** Derive the public API base from the <script> that loaded widget.js (override via init.apiUrl). */
function detectApiBase(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, '')
  const scripts = Array.from(document.getElementsByTagName('script'))
  const self = scripts.find((s) => s.src && s.src.indexOf('widget.js') !== -1)
  const origin = self ? new URL(self.src).origin : location.origin
  return `${origin}/api/v1`
}

function buildApi(): Api | null {
  if (!config) return null
  const apiBase = detectApiBase(config.apiUrl)
  return createApi({
    apiBase,
    projectKey: config.projectKey,
    jwt: config.user?.jwt,
    appVersion: config.appVersion,
  })
}

function startInstance() {
  if (!config || !ctx) return
  const mode: Mode = ctx.settings.mode ?? 'floating'
  instance?.destroy()
  instance = null
  if (mode === 'inline') return // inline is created via render()
  instance = mountWidget({
    api: ctx.api,
    locale: ctx.locale,
    settings: ctx.settings,
    mode,
    defaultView: config.view ?? 'board',
  })
}

function handle(cmd: Cmd) {
  const [name, a1, a2] = cmd
  switch (name) {
    case 'init': {
      destroyInstances()
      ctx = null
      config = a1 as InitOptions
      if (!config?.projectKey) {
        console.error('[chorala] init requires { projectKey }')
        return
      }
      const api = buildApi()
      if (!api) return
      ctx = { api, locale: resolveLocale(config.locale), settings: config.settings ?? {} }
      startInstance()
      emit('ready')
      break
    }
    case 'identify': {
      const containers = [...inlineInstances].map(([container, mounted]) => ({
        container,
        view: mounted.view,
      }))
      destroyInstances()
      if (config) config.user = (a1 ?? {}) as { jwt?: string }
      const api = buildApi()
      if (api && ctx) {
        ctx = { ...ctx, api }
        startInstance()
        for (const { container, view } of containers) {
          if (container.isConnected) renderInline(container, view)
        }
      }
      break
    }
    case 'refreshIdentity': {
      // Hosts must use identify for an account change. This command only renews
      // the same user's token and deliberately retains forms and attachments.
      const user = (a1 ?? {}) as { jwt?: string }
      if (config) config.user = user
      ctx?.api.setJwt(user.jwt)
      break
    }
    case 'open':
      instance?.open(a1 as View | undefined)
      break
    case 'close':
      instance?.close()
      break
    case 'render': {
      const container = document.querySelector(a1 as string)
      const opts = (a2 ?? {}) as { view?: View }
      if (container && ctx) {
        renderInline(container, opts.view ?? 'board')
      }
      break
    }
    case 'on': {
      const event = a1 as string
      const cb = a2 as EventCb
      if (!listeners[event]) listeners[event] = []
      listeners[event].push(cb)
      break
    }
    default:
      console.warn('[chorala] unknown command:', name)
  }
}

// Replace the loader's queue stub with the real processor and replay queued commands.
const w = window as unknown as { Chorala?: { q?: unknown[][] } }
const queued: unknown[][] = w.Chorala?.q ?? []
const run = Object.assign((...args: unknown[]) => handle(args as Cmd), {
  supportsIdentityRefresh: true,
})
;(w as unknown as { Chorala: unknown }).Chorala = run
for (const c of queued) handle(c as Cmd)

// Self-configuring embed (modern, no inline JS). Everything — including SSO — fits in
// one tag's data-* attributes; only if init wasn't already queued programmatically (above):
//   <script async src=".../widget.js" data-chorala-key="pk_…" data-jwt="eyJ…"></script>
// A `window.choralaSettings` object is also honoured for JS-computed config.
if (!config) {
  const settings = (w as unknown as { choralaSettings?: InitOptions }).choralaSettings
  const tag =
    (document.currentScript as HTMLScriptElement | null) ??
    document.querySelector<HTMLScriptElement>('script[data-chorala-key]')
  const d = tag?.dataset
  const key = settings?.projectKey ?? d?.choralaKey
  if (key) {
    handle([
      'init',
      {
        projectKey: key,
        locale: settings?.locale ?? d?.locale ?? 'auto',
        appVersion: settings?.appVersion ?? d?.appVersion,
        view: (settings?.view ?? d?.view) as View | undefined,
        user: settings?.user ?? (d?.jwt ? { jwt: d.jwt } : undefined),
        settings: settings?.settings ?? {
          mode: (d?.mode as Mode | undefined) ?? 'floating',
          primaryColor: d?.color,
        },
      },
    ] as Cmd)
  }
}
