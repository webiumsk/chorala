import { afterEach, describe, expect, it } from 'vitest'
import { changelogDate } from '../src/changelog-date.ts'

const originalTimezone = process.env.TZ

afterEach(() => {
  if (originalTimezone === undefined) delete process.env.TZ
  else process.env.TZ = originalTimezone
})

describe('widget changelog calendar date', () => {
  it.each(['America/Los_Angeles', 'Pacific/Honolulu', 'Pacific/Kiritimati', 'Europe/Prague'])(
    'preserves the selected calendar day in browser timezone %s',
    (timezone) => {
      process.env.TZ = timezone
      expect(
        changelogDate({ displayDate: '2026-08-16', publishedAt: '2026-10-26T12:00:00Z' }, 'en-GB'),
      ).toEqual({ dateTime: '2026-08-16', label: '16/08/2026' })
    },
  )

  it('retains a valid leap day', () => {
    expect(changelogDate({ displayDate: '2024-02-29', publishedAt: null }, 'en-GB')).toEqual({
      dateTime: '2024-02-29',
      label: '29/02/2024',
    })
  })

  it.each([
    '2026-02-29',
    '2026-02-30',
    '2026-13-01',
    '2026-8-16',
    '2026-08-16T00:00:00Z',
    'bad',
    '',
  ])(
    'rejects malformed/impossible display dates and falls back to publication: %s',
    (displayDate) => {
      process.env.TZ = 'UTC'
      expect(changelogDate({ displayDate, publishedAt: '2026-10-26T12:00:00Z' }, 'en-GB')).toEqual({
        dateTime: '2026-10-26T12:00:00.000Z',
        label: '26/10/2026',
      })
    },
  )

  it('supports older servers that omit displayDate', () => {
    process.env.TZ = 'UTC'
    expect(changelogDate({ publishedAt: '2026-10-26T12:00:00Z' }, 'en-GB')).toEqual({
      dateTime: '2026-10-26T12:00:00.000Z',
      label: '26/10/2026',
    })
  })

  it('preserves legacy local-time display for publication timestamps', () => {
    process.env.TZ = 'America/Los_Angeles'
    expect(
      changelogDate({ displayDate: null, publishedAt: '2026-10-26T00:30:00Z' }, 'en-GB'),
    ).toEqual({
      dateTime: '2026-10-26T00:30:00.000Z',
      label: '25/10/2026',
    })
  })

  it('omits absent or invalid publication dates instead of showing Invalid Date', () => {
    expect(changelogDate({ publishedAt: null }, 'en-GB')).toBeNull()
    expect(changelogDate({ publishedAt: 'invalid' }, 'en-GB')).toBeNull()
  })

  it('keeps a valid calendar date even when publication is absent', () => {
    expect(changelogDate({ displayDate: '2026-08-16', publishedAt: null }, 'en-GB')?.dateTime).toBe(
      '2026-08-16',
    )
  })

  it('falls back to the browser locale if the host provides an invalid locale', () => {
    expect(
      changelogDate({ displayDate: '2026-08-16', publishedAt: null }, 'not_a_locale')?.dateTime,
    ).toBe('2026-08-16')
  })
})
