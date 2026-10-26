import { describe, expect, test } from 'vitest'
import { newestChangelogFirst } from '../src/changelog-order.ts'

const createdAt = new Date('2026-10-26T08:00:00Z')
const entry = (
  id: string,
  overrides: Partial<{
    title: string
    labels: string[]
    publishedAt: Date | null
    createdAt: Date
  }> = {},
) => ({
  id,
  title: 'Product update',
  labels: [] as string[],
  publishedAt: null,
  createdAt,
  ...overrides,
})
const history = (id: string, date: string, publishedAt: Date | null = null) =>
  entry(id, {
    title: `Satflux development history - ${date}`,
    labels: ['Satflux', 'development-history'],
    publishedAt,
  })
const ids = (entries: ReturnType<typeof entry>[]) =>
  newestChangelogFirst(entries).map((item) => item.id)

describe('newest-first changelog order', () => {
  test('orders a simultaneously imported draft batch by original history date', () => {
    expect(
      ids([
        history('cl_old', '2026-01-31'),
        history('cl_new', '2026-10-25'),
        history('cl_middle', '2026-08-06'),
      ]),
    ).toEqual(['cl_new', 'cl_middle', 'cl_old'])
  })

  test('preserves historical order when old entries are published together', () => {
    expect(
      ids([history('cl_old', '2026-01-31', createdAt), history('cl_new', '2026-10-25', createdAt)]),
    ).toEqual(['cl_new', 'cl_old'])
  })

  test('uses publication date for ordinary entries without pinning drafts above them', () => {
    expect(
      ids([
        entry('cl_draft', { createdAt: new Date('2026-09-01T00:00:00Z') }),
        entry('cl_published', { publishedAt: new Date('2026-10-25T18:30:00Z') }),
        entry('cl_newdraft', { createdAt }),
      ]),
    ).toEqual(['cl_newdraft', 'cl_published', 'cl_draft'])
  })

  test('does not treat arbitrary dated titles as source dates', () => {
    expect(
      ids([
        entry('cl_plain', {
          title: 'Roadmap 2099-12-31',
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        entry('cl_unlabelled', {
          title: 'Another project history - 2099-12-31',
          createdAt: new Date('2026-02-01T00:00:00Z'),
        }),
        entry('cl_latest'),
      ]),
    ).toEqual(['cl_latest', 'cl_unlabelled', 'cl_plain'])
  })

  test('changing category labels does not change imported history chronology', () => {
    const old = { ...history('cl_old', '2026-01-31'), labels: [] }
    const latest = { ...history('cl_new', '2026-10-25'), labels: ['fixed'] }
    expect(ids([old, latest])).toEqual(['cl_new', 'cl_old'])
  })

  test('rejects rolled-over or malformed historical calendar dates', () => {
    expect(
      ids([
        history('cl_invalid', '2026-02-30'),
        history('cl_malformed', '2026-2-1'),
        history('cl_valid', '2026-02-28'),
      ]),
    ).toEqual(['cl_malformed', 'cl_invalid', 'cl_valid'])
  })

  test('breaks identical dates by creation time and then ID consistently', () => {
    const samePublication = new Date('2026-10-25T00:00:00Z')
    expect(
      ids([
        entry('cl_a', { publishedAt: samePublication }),
        entry('cl_oldcreated', {
          publishedAt: samePublication,
          createdAt: new Date('2026-01-01T00:00:00Z'),
        }),
        entry('cl_b', { publishedAt: samePublication }),
      ]),
    ).toEqual(['cl_b', 'cl_a', 'cl_oldcreated'])
  })

  test('places invalid timestamps last without throwing', () => {
    expect(
      ids([
        entry('cl_invalid', { publishedAt: new Date(Number.NaN), createdAt: new Date(Number.NaN) }),
        entry('cl_valid'),
      ]),
    ).toEqual(['cl_valid', 'cl_invalid'])
  })

  test('does not mutate the input array, row objects or publication dates', () => {
    const old = Object.freeze(history('cl_old', '2026-01-31', createdAt))
    const latest = Object.freeze(history('cl_new', '2026-10-25', createdAt))
    const input = Object.freeze([old, latest])
    const result = newestChangelogFirst(input)
    expect(result).toEqual([latest, old])
    expect(input).toEqual([old, latest])
    expect(result[0]).toBe(latest)
    expect(old.publishedAt).toBe(createdAt)
  })
})
