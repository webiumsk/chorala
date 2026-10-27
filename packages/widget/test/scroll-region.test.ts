import { describe, expect, it, vi } from 'vitest'
import { App } from '../src/App.tsx'
import type { Api } from '../src/api.ts'
import { makeTranslator } from '../src/i18n.ts'

vi.mock('preact/hooks', async (importOriginal) => {
  const hooks = await importOriginal<typeof import('preact/hooks')>()
  return {
    ...hooks,
    useState: (initial: unknown) => [initial, vi.fn()],
    useEffect: vi.fn(),
    useCallback: (callback: unknown) => callback,
  }
})

type Element = { type: unknown; props: Record<string, unknown> }

function children(node: Element): Element[] {
  const values = node.props.children
  return (Array.isArray(values) ? values : [values]).filter((value): value is Element =>
    Boolean(value && typeof value === 'object' && 'props' in value),
  )
}

describe('widget scrolling region structure', () => {
  it.each([false, true])(
    'keeps chrome outside one focusable named content region (inline=%s)',
    (inline) => {
      const t = makeTranslator('sk')
      const root = App({
        api: {} as Api,
        t,
        locale: 'sk',
        initialView: 'changelog',
        inline,
        onClose: vi.fn(),
      }) as Element
      expect(root.props.class).toContain('chorala-app')
      const direct = children(root)
      expect(direct.map((node) => node.props.class)).toEqual([
        'chorala-header',
        'chorala-tabs',
        'chorala-body',
        'chorala-footer',
      ])
      expect(direct[2]?.type).toBe('section')
      expect(direct[2]?.props.tabIndex).toBe(0)
      expect(direct[2]?.props['aria-label']).toBe(t('changelog'))
    },
  )
})
