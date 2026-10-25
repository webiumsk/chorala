import { describe, expect, it } from 'vitest'
import { makeTranslator, resolveLocale, STRINGS } from '../src/i18n.ts'

describe('widget translations', () => {
  it.each(Object.entries(STRINGS))('has complete nonempty English-key parity for %s', (_, dict) => {
    expect(Object.keys(dict).sort()).toEqual(Object.keys(STRINGS.en).sort())
    for (const value of Object.values(dict)) expect(value.trim().length).toBeGreaterThan(0)
  })

  it.each([
    ['sk-SK', 'Odoslať návrh'],
    ['de-DE', 'Vorschlag einreichen'],
    ['cs-CZ', 'Odeslat návrh'],
    ['es-ES', 'Enviar una idea'],
    ['fr-FR', 'Proposer une idée'],
    ['en-US', 'Submit an idea'],
  ])('resolves localized regional code %s', (locale, title) => {
    expect(makeTranslator(locale)('submitIdea')).toBe(title)
  })

  it('keeps English and unknown-key fallbacks', () => {
    expect(makeTranslator('unknown')('submitIdea')).toBe('Submit an idea')
    expect(makeTranslator('sk')('not-a-key')).toBe('not-a-key')
    expect(resolveLocale('sk-SK')).toBe('sk-SK')
  })
})
