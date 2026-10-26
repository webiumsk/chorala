type ChangelogEntry = {
  id: string
  title: string
  displayDate?: string | null
  publishedAt: Date | null
  createdAt: Date
}

function timestamp(value: Date | null): number | undefined {
  const time = value?.getTime()
  return time !== undefined && Number.isFinite(time) ? time : undefined
}

/** Calendar dates are interpreted in UTC without rolling invalid dates forward. */
function calendarTimestamp(date: string | null | undefined): number | undefined {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date.startsWith('0000-')) return undefined
  const time = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return undefined
  return time
}

function historicalDate(entry: ChangelogEntry): number | undefined {
  // Compatibility for old objects only. Persisted null explicitly selects timestamp fallback.
  if (entry.displayDate !== undefined) return undefined
  return calendarTimestamp(
    /^Satflux development history - (\d{4}-\d{2}-\d{2})$/.exec(entry.title)?.[1],
  )
}

/** Shared order for admin and public feeds; never mutates entries or stored dates. */
export function newestChangelogFirst<T extends ChangelogEntry>(entries: readonly T[]): T[] {
  const ranked = entries.map((entry) => ({
    entry,
    date:
      calendarTimestamp(entry.displayDate) ??
      historicalDate(entry) ??
      timestamp(entry.publishedAt) ??
      timestamp(entry.createdAt) ??
      Number.NEGATIVE_INFINITY,
    created: timestamp(entry.createdAt) ?? Number.NEGATIVE_INFINITY,
  }))
  ranked.sort((a, b) => {
    if (a.date !== b.date) return a.date > b.date ? -1 : 1
    if (a.created !== b.created) return a.created > b.created ? -1 : 1
    return a.entry.id === b.entry.id ? 0 : a.entry.id > b.entry.id ? -1 : 1
  })
  return ranked.map(({ entry }) => entry)
}
