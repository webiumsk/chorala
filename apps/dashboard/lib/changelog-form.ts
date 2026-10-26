import { createChangelogInput, updateChangelogInput } from '@chorala/types'

const PROJECT_ID = /^proj_[A-Za-z0-9]{1,80}$/
const ENTRY_ID = /^cl_[A-Za-z0-9]{1,80}$/
const SEGMENT_ID = /^seg_[A-Za-z0-9]{1,80}$/

function field(formData: FormData, name: string, required = true): string | null {
  const values = formData.getAll(name)
  if (values.length === 0 && !required) return null
  if (values.length !== 1 || typeof values[0] !== 'string') {
    throw new Error(`Invalid changelog field: ${name}`)
  }
  return values[0]
}

/** Form IDs select a resource only; the server's scoped services authorize it. */
export function parseChangelogTarget(formData: FormData) {
  const projectId = field(formData, 'projectId')
  const id = field(formData, 'id', false)
  if (!projectId || !PROJECT_ID.test(projectId) || (id !== null && !ENTRY_ID.test(id))) {
    throw new Error('Invalid changelog target')
  }
  return { projectId, id }
}

/** Omit unchanged relationship/status fields instead of replacing them with defaults. */
export function parseChangelogForm(formData: FormData) {
  const target = parseChangelogTarget(formData)
  const publish = field(formData, 'publish', false)
  const draft = field(formData, 'draft', false)
  if (
    (publish !== null && publish !== '1') ||
    (draft !== null && draft !== '1') ||
    (publish !== null && draft !== null)
  ) {
    throw new Error('Invalid changelog publication intent')
  }
  const title = field(formData, 'title')?.trim()
  const body = field(formData, 'body')
  const labels = field(formData, 'labels')
    ?.split(',')
    .map((label) => label.trim())
    .filter(Boolean)
  const segmentId = field(formData, 'segmentId') || null
  if (segmentId !== null && !SEGMENT_ID.test(segmentId)) {
    throw new Error('Invalid changelog audience')
  }
  const displayDate = field(formData, 'displayDate', false)
  const fields = {
    title,
    body,
    labels,
    segmentId,
    ...(displayDate === null ? {} : { displayDate: displayDate || null }),
  }
  const status = publish === '1' ? 'published' : draft === '1' ? 'draft' : undefined

  if (target.id !== null) {
    // Zod defaults nested inside a partial schema must not clear linked posts or
    // accidentally turn a published entry back into a draft on an ordinary save.
    const schema =
      status === undefined
        ? updateChangelogInput.omit({ linkedPostIds: true, status: true })
        : updateChangelogInput.omit({ linkedPostIds: true })
    const parsed = schema.safeParse(status === undefined ? fields : { ...fields, status })
    if (!parsed.success || !title) throw new Error('Invalid changelog content')
    return { ...target, id: target.id, payload: parsed.data }
  }

  const parsed = createChangelogInput.safeParse({ ...fields, status: status ?? 'draft' })
  if (!parsed.success || !title) throw new Error('Invalid changelog content')
  return { ...target, id: null, payload: parsed.data }
}
