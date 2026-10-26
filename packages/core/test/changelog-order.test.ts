import { changelogEntry, createChangelogInput, updateChangelogInput } from '@chorala/types'
import { describe, expect, test } from 'vitest'
import { newestChangelogFirst } from '../src/changelog-order.ts'

const createdAt = new Date('2026-10-26T08:00:00Z')
const entry = (
  id: string,
  overrides: Partial<{
    title: string
    displayDate: string | null
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

  test('uses persisted display dates after arbitrary title, body and category edits', () => {
    const changed = [
      entry('cl_august', {
        title: '2026-08-16',
        displayDate: '2026-08-16',
        publishedAt: createdAt,
        labels: ['fixed'],
      }),
      entry('cl_october', {
        title: 'A completely rewritten title',
        displayDate: '2026-10-25',
        publishedAt: createdAt,
        labels: [],
      }),
      entry('cl_september', {
        title: 'Not a date',
        displayDate: '2026-09-01',
        publishedAt: createdAt,
      }),
    ]
    expect(ids(changed)).toEqual(['cl_october', 'cl_september', 'cl_august'])
  })

  test('a persisted date takes precedence over both title and publication date', () => {
    expect(
      ids([
        entry('cl_old', {
          title: 'Satflux development history - 2099-12-31',
          displayDate: '2026-08-16',
          publishedAt: new Date('2099-12-31T00:00:00Z'),
        }),
        entry('cl_new', { displayDate: '2026-10-25', publishedAt: createdAt }),
      ]),
    ).toEqual(['cl_new', 'cl_old'])
  })

  test('explicitly null dates use timestamps instead of resurrecting a legacy title date', () => {
    expect(
      ids([
        entry('cl_cleared', {
          title: 'Satflux development history - 2099-12-31',
          displayDate: null,
          publishedAt: new Date('2026-08-16T00:00:00Z'),
        }),
        entry('cl_new', { displayDate: '2026-10-25' }),
      ]),
    ).toEqual(['cl_new', 'cl_cleared'])
  })

  test('invalid stored calendar dates fall back without rolling into another day', () => {
    expect(
      ids([
        entry('cl_invalid', { displayDate: '2026-02-30' }),
        entry('cl_valid', { displayDate: '2026-02-28' }),
      ]),
    ).toEqual(['cl_invalid', 'cl_valid']) // Invalid date falls back to the later creation time.
    expect(ids([entry('cl_leap', { displayDate: '2024-02-29' })])).toEqual(['cl_leap'])
  })
})

describe('changelog calendar date contracts', () => {
  test.each(['2026-08-16', '2024-02-29', '0001-01-01', '9999-12-31'])(
    'accepts a real calendar date in API and DTO schemas: %s',
    (displayDate) => {
      expect(createChangelogInput.parse({ title: 'Date', body: '', displayDate }).displayDate).toBe(
        displayDate,
      )
      expect(updateChangelogInput.parse({ displayDate }).displayDate).toBe(displayDate)
      expect(changelogEntry.shape.displayDate.parse(displayDate)).toBe(displayDate)
    },
  )

  test.each([
    '2026-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-13-01',
    '2026-00-01',
    '2026-01-00',
    '0000-01-01',
    '2026-8-16',
    ' 2026-08-16',
    '2026-08-16T00:00:00Z',
    '',
  ])('rejects malformed or rolled-over API/DTO dates: %s', (displayDate) => {
    expect(createChangelogInput.safeParse({ title: 'Date', body: '', displayDate }).success).toBe(
      false,
    )
    expect(updateChangelogInput.safeParse({ displayDate }).success).toBe(false)
    expect(changelogEntry.shape.displayDate.safeParse(displayDate).success).toBe(false)
  })

  test('omission preserves PATCH intent while null explicitly clears a date', () => {
    expect(updateChangelogInput.parse({ title: 'Renamed' })).not.toHaveProperty('displayDate')
    expect(updateChangelogInput.parse({ displayDate: null })).toHaveProperty('displayDate', null)
    expect(changelogEntry.shape.displayDate.parse(undefined)).toBeUndefined()
    expect(changelogEntry.shape.displayDate.parse(null)).toBeNull()
  })

  test('date-only PATCH parsing never adds publication or relationship defaults', () => {
    expect(updateChangelogInput.parse({ displayDate: '2026-08-16' })).toEqual({
      displayDate: '2026-08-16',
    })
    expect(updateChangelogInput.parse({ displayDate: null })).toEqual({ displayDate: null })
    expect(updateChangelogInput.parse({ title: 'Renamed' })).toEqual({ title: 'Renamed' })
    expect(updateChangelogInput.parse({})).toEqual({})
    expect(createChangelogInput.parse({ title: 'New entry', body: '' })).toMatchObject({
      status: 'draft',
      labels: [],
      linkedPostIds: [],
    })
  })
})
