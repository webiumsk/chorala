import type { ChangelogEntry } from './types.ts'

/** Calendar dates are formatted in UTC so browser timezones cannot move the day. */
export function changelogDate(
  entry: Pick<ChangelogEntry, 'displayDate' | 'publishedAt'>,
  locale: string,
): { dateTime: string; label: string } | null {
  const label = (date: Date, calendar = false) => {
    const options = calendar ? { timeZone: 'UTC' } : undefined
    try {
      return date.toLocaleDateString(locale, options)
    } catch {
      return date.toLocaleDateString(undefined, options)
    }
  }
  const day = entry.displayDate
  if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day)) {
    const parsed = new Date(`${day}T00:00:00.000Z`)
    if (Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === day)
      return {
        dateTime: day,
        label: label(parsed, true),
      }
  }
  // Older servers do not send displayDate; preserve their publication-time fallback.
  if (!entry.publishedAt) return null
  const published = new Date(entry.publishedAt)
  if (!Number.isFinite(published.getTime())) return null
  return { dateTime: published.toISOString(), label: label(published) }
}
