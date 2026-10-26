import { render } from 'preact'
import { useEffect, useState } from 'preact/hooks'
import { App } from './App.tsx'
import type { Api } from './api.ts'
import { makeTranslator } from './i18n.ts'
import { buildStyles } from './styles.ts'
import type { Mode, View, WidgetSettings } from './types.ts'

export type Instance = {
  open: (view?: View) => void
  close: () => void
  destroy: () => void
}

type MountOpts = {
  api: Api
  locale: string
  settings: WidgetSettings
  mode: Mode
  defaultView: View
  container?: Element | null
}

type Control = { setOpen: (o: boolean) => void; setView: (v: View) => void }

export function mountWidget(opts: MountOpts): Instance {
  const t = makeTranslator(opts.locale)

  // Shadow DOM root → host CSS can never leak in or out (SPEC §9).
  const host = document.createElement('div')
  host.setAttribute('data-chorala-widget', '')
  const shadow = host.attachShadow({ mode: 'open' })
  const styleEl = document.createElement('style')
  styleEl.textContent = buildStyles(opts.settings)
  shadow.appendChild(styleEl)
  const mountPoint = document.createElement('div')
  shadow.appendChild(mountPoint)

  const parent = opts.mode === 'inline' ? (opts.container ?? document.body) : document.body
  parent.appendChild(host)

  let control: Control | null = null

  function Root() {
    const [open, setOpen] = useState(opts.mode === 'inline')
    const [view, setView] = useState<View>(opts.defaultView)
    useEffect(() => {
      control = { setOpen, setView }
    }, [])
    useEffect(() => {
      if (opts.mode === 'inline') return
      const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Escape') setOpen(false)
      }
      document.addEventListener('keydown', onKey)
      return () => document.removeEventListener('keydown', onKey)
    }, [])

    const panel = (
      <App
        api={opts.api}
        t={t}
        locale={opts.locale}
        initialView={view}
        inline={opts.mode === 'inline'}
        onClose={() => setOpen(false)}
      />
    )

    if (opts.mode === 'inline')
      return (
        <div class="chorala-root chorala-inline">
          <div class="chorala-panel">{panel}</div>
        </div>
      )

    return (
      <div class="chorala-root">
        {opts.mode === 'floating' && !open && (
          <button type="button" class="chorala-launcher" onClick={() => setOpen(true)}>
            💬 {t('feedback')}
          </button>
        )}
        {open && (
          <div
            class="chorala-overlay"
            onClick={(e) => {
              if (e.target === e.currentTarget) setOpen(false)
            }}
          >
            <div class="chorala-panel">{panel}</div>
          </div>
        )}
      </div>
    )
  }

  render(<Root />, mountPoint)

  return {
    open: (view?: View) => {
      if (view) control?.setView(view)
      control?.setOpen(true)
    },
    close: () => control?.setOpen(false),
    destroy: () => {
      render(null, mountPoint)
      host.remove()
    },
  }
}
