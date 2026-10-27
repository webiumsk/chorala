type EntryDate = { displayDate?: string | null; publishedAt: Date | string | null }

/** Calendar dates retain their day independently of the server/browser timezone. */
export function changelogDate(entry: EntryDate, locale?: string) {
  if (entry.displayDate) {
    const value = new Date(`${entry.displayDate}T00:00:00.000Z`)
    if (
      /^\d{4}-\d{2}-\d{2}$/.test(entry.displayDate) &&
      Number.isFinite(value.getTime()) &&
      value.toISOString().slice(0, 10) === entry.displayDate
    ) {
      return {
        dateTime: entry.displayDate,
        label: value.toLocaleDateString(locale, { timeZone: 'UTC' }),
      }
    }
  }
  if (!entry.publishedAt) return null
  const value = new Date(entry.publishedAt)
  if (!Number.isFinite(value.getTime())) return null
  return { dateTime: value.toISOString(), label: value.toLocaleDateString(locale) }
}
