'use client'

import { type FormEvent, useId, useRef, useState, useTransition } from 'react'
import { ChangelogMarkdown } from '@/components/changelog-markdown'
import { Badge, Button, Card, Input, Label, Select, Textarea } from '@/components/ui'
import { deleteChangelog, saveChangelog } from '@/lib/actions'

type Entry = {
  id: string
  title: string
  body: string
  labels: string[]
  status: 'draft' | 'published'
  segmentId: string | null
  recipientCount: number
  displayDate?: string | null
}

type Segment = { id: string; name: string; matchCount: number }

export function ChangelogManager({
  projectId,
  canWrite,
  entries,
  segments,
}: {
  projectId: string
  canWrite: boolean
  entries: Entry[]
  segments: Segment[]
}) {
  const fieldId = useId()
  const editor = useRef<HTMLFormElement>(null)
  const [selected, setSelected] = useState<Entry | null>(null)
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [labels, setLabels] = useState('')
  const [segmentId, setSegmentId] = useState('')
  const [displayDate, setDisplayDate] = useState('')
  const [preview, setPreview] = useState(false)
  const [filter, setFilter] = useState('all')
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [, startTransition] = useTransition()
  const segmentNames = new Map(segments.map((segment) => [segment.id, segment.name]))
  const dirty =
    title !== (selected?.title ?? '') ||
    body !== (selected?.body ?? '') ||
    labels !== (selected?.labels.join(', ') ?? '') ||
    segmentId !== (selected?.segmentId ?? '') ||
    displayDate !== (selected?.displayDate ?? '')

  function fillEditor(entry: Entry | null) {
    setSelected(entry)
    setTitle(entry?.title ?? '')
    setBody(entry?.body ?? '')
    setLabels(entry?.labels.join(', ') ?? '')
    setSegmentId(entry?.segmentId ?? '')
    setDisplayDate(entry?.displayDate ?? '')
    setPreview(false)
    setError(null)
  }

  function openEditor(entry: Entry | null) {
    if (dirty && !window.confirm('Discard your unsaved changes?')) return
    fillEditor(entry)
    setMessage(null)
    requestAnimationFrame(() => {
      editor.current?.scrollIntoView({ block: 'start' })
      editor.current
        ?.querySelector<HTMLInputElement>('[name="title"]')
        ?.focus({ preventScroll: true })
    })
  }

  async function handleSave(formData: FormData) {
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await saveChangelog(formData)
      const nextStatus = formData.has('publish')
        ? 'published'
        : formData.has('draft')
          ? 'draft'
          : (selected?.status ?? 'draft')
      if (selected) {
        fillEditor({
          ...selected,
          title,
          body,
          labels: labels
            .split(',')
            .map((label) => label.trim())
            .filter(Boolean),
          segmentId: segmentId || null,
          displayDate: displayDate || null,
          status: nextStatus,
        })
      } else {
        fillEditor(null)
      }
      setMessage(nextStatus === 'published' ? 'Published entry saved.' : 'Draft saved.')
    } catch {
      setError('The entry could not be saved. Your changes are still here; please try again.')
    } finally {
      setPending(false)
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (pending) return
    // Snapshot the submitter before pending disables its fieldset. React function
    // actions otherwise omit the intent and reset the controlled audience select.
    const submitter = (event.nativeEvent as SubmitEvent).submitter
    const formData = new FormData(event.currentTarget, submitter)
    startTransition(() => handleSave(formData))
  }

  async function handleDelete(entry: Entry) {
    if (!window.confirm(`Delete "${entry.title}"? This cannot be undone.`)) return
    setPending(true)
    setError(null)
    setMessage(null)
    try {
      await deleteChangelog(projectId, entry.id)
      if (selected?.id === entry.id) fillEditor(null)
      setMessage('Entry deleted.')
    } catch {
      setError('The entry could not be deleted. Please try again.')
    } finally {
      setPending(false)
    }
  }

  const visibleEntries = entries.filter((entry) => filter === 'all' || entry.status === filter)

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Changelog</h1>
      {error && (
        <p role="alert" className="rounded-lg border border-red-500/30 p-3 text-sm text-red-600">
          {error}
        </p>
      )}
      {message && <output className="block text-sm text-ink-soft">{message}</output>}
      <div className="grid min-w-0 grid-cols-1 items-start gap-5 lg:grid-cols-2">
        {canWrite ? (
          <Card className="min-w-0 p-5 lg:sticky lg:top-5">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold">{selected ? 'Edit entry' : 'New entry'}</h2>
              {selected && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={pending}
                  onClick={() => openEditor(null)}
                >
                  New entry
                </Button>
              )}
            </div>
            <form ref={editor} method="post" onSubmit={handleSubmit}>
              <input type="hidden" name="projectId" value={projectId} />
              {selected && <input type="hidden" name="id" value={selected.id} />}
              <fieldset disabled={pending} className="min-w-0 space-y-4">
                <div>
                  <Label htmlFor={`${fieldId}-title`}>Title</Label>
                  <Input
                    id={`${fieldId}-title`}
                    name="title"
                    required
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor={`${fieldId}-date`}>Changelog date</Label>
                  <Input
                    id={`${fieldId}-date`}
                    name="displayDate"
                    type="date"
                    value={displayDate}
                    onChange={(event) => setDisplayDate(event.target.value)}
                    aria-describedby={`${fieldId}-date-help`}
                  />
                  <p id={`${fieldId}-date-help`} className="mt-1 text-xs text-ink-faint">
                    Sets the displayed date and newest-first order. Leave empty to use the
                    publication date. Editing the title or body keeps this date.
                  </p>
                </div>
                <div>
                  <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                    <Label htmlFor={`${fieldId}-body`} className="mb-0">
                      Body (Markdown)
                    </Label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-pressed={preview}
                      onClick={() => setPreview(!preview)}
                    >
                      {preview ? 'Write' : 'Preview'}
                    </Button>
                  </div>
                  <Textarea
                    id={`${fieldId}-body`}
                    name="body"
                    className={preview ? 'hidden' : 'min-h-64'}
                    value={body}
                    onChange={(event) => setBody(event.target.value)}
                  />
                  {preview && (
                    <section
                      className="min-h-64 rounded-lg border border-line-strong p-3"
                      aria-label="Markdown preview"
                    >
                      {body ? (
                        <ChangelogMarkdown body={body} />
                      ) : (
                        <p className="text-sm text-ink-faint">Nothing to preview.</p>
                      )}
                    </section>
                  )}
                </div>
                <div>
                  <Label htmlFor={`${fieldId}-labels`}>Labels (comma-separated)</Label>
                  <Input
                    id={`${fieldId}-labels`}
                    name="labels"
                    placeholder="new, improved, fixed"
                    value={labels}
                    onChange={(event) => setLabels(event.target.value)}
                  />
                </div>
                <div>
                  <Label htmlFor={`${fieldId}-audience`}>Audience</Label>
                  <Select
                    id={`${fieldId}-audience`}
                    name="segmentId"
                    value={segmentId}
                    onChange={(event) => setSegmentId(event.target.value)}
                  >
                    <option value="">Everyone (all subscribers)</option>
                    {segments.map((segment) => (
                      <option key={segment.id} value={segment.id}>
                        {segment.name} ({segment.matchCount})
                      </option>
                    ))}
                  </Select>
                  <p className="mt-2 text-xs text-ink-faint">
                    Publishing makes this entry public and sends notifications to its audience.
                    Saving a draft keeps it private.
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {selected?.status === 'published' ? (
                    <Button type="submit">{pending ? 'Saving...' : 'Save changes'}</Button>
                  ) : (
                    <>
                      <Button type="submit" variant="outline" name="draft" value="1">
                        {pending ? 'Saving...' : 'Save draft'}
                      </Button>
                      <Button type="submit" name="publish" value="1">
                        Publish
                      </Button>
                    </>
                  )}
                  {(selected || dirty) && (
                    <Button type="button" variant="ghost" onClick={() => openEditor(null)}>
                      Cancel
                    </Button>
                  )}
                </div>
              </fieldset>
            </form>
          </Card>
        ) : (
          <Card className="p-5 text-sm text-ink-soft">
            You have read-only access. An organization owner or admin can edit and publish entries.
          </Card>
        )}

        <section className="min-w-0 space-y-3" aria-label="Changelog entries">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 className="font-semibold">Entries ({entries.length})</h2>
            <div>
              <Label htmlFor={`${fieldId}-filter`}>Show</Label>
              <Select
                id={`${fieldId}-filter`}
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
              >
                <option value="all">All entries</option>
                <option value="draft">Drafts</option>
                <option value="published">Published</option>
              </Select>
            </div>
          </div>
          {visibleEntries.length === 0 && (
            <p className="text-sm text-ink-faint">No entries match this view.</p>
          )}
          {visibleEntries.map((entry) => (
            <Card
              key={entry.id}
              className={`min-w-0 p-4 ${selected?.id === entry.id ? 'ring-2 ring-accent/40' : ''}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="min-w-0 break-words font-semibold">{entry.title}</h3>
                <Badge>{entry.status}</Badge>
                {entry.segmentId && (
                  <Badge>{segmentNames.get(entry.segmentId) ?? 'Segment audience'}</Badge>
                )}
                {entry.status === 'published' && entry.recipientCount > 0 && (
                  <span className="text-xs text-ink-faint">{entry.recipientCount} emailed</span>
                )}
              </div>
              {entry.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                  {[...new Set(entry.labels)].map((label) => (
                    <Badge key={label}>{label}</Badge>
                  ))}
                </div>
              )}
              <details className="mt-3 text-sm">
                <summary className="cursor-pointer text-ink-soft">Read preview</summary>
                <div className="mt-3">
                  <ChangelogMarkdown body={entry.body} />
                </div>
              </details>
              {canWrite && (
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending}
                    aria-label={`Edit ${entry.title}`}
                    onClick={() => openEditor(entry)}
                  >
                    Edit
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    aria-label={`Delete ${entry.title}`}
                    onClick={() => void handleDelete(entry)}
                  >
                    Delete
                  </Button>
                </div>
              )}
            </Card>
          ))}
        </section>
      </div>
    </div>
  )
}
