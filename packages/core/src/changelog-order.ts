type ChangelogEntry = {
  id: string
  title: string
  publishedAt: Date | null
  createdAt: Date
}

function timestamp(value: Date | null): number | undefined {
  const time = value?.getTime()
  return time !== undefined && Number.isFinite(time) ? time : undefined
}

/** Imported PR history has a source date in its title, not a release timestamp. */
function historicalDate(entry: ChangelogEntry): number | undefined {
  const date = /^Satflux development history - (\d{4}-\d{2}-\d{2})$/.exec(entry.title)?.[1]
  if (!date) return undefined
  const time = Date.parse(`${date}T00:00:00.000Z`)
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== date) return undefined
  return time
}

/** Shared order for admin and public feeds; never mutates entries or stored dates. */
export function newestChangelogFirst<T extends ChangelogEntry>(entries: readonly T[]): T[] {
  const ranked = entries.map((entry) => ({
    entry,
    date:
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
