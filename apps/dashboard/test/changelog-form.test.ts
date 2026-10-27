import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseChangelogForm } from '../lib/changelog-form.ts'

function form(edit = true) {
  const data = new FormData()
  data.set('projectId', 'proj_Synthetic')
  if (edit) data.set('id', 'cl_Imported')
  data.set('title', ' Historical changes ')
  data.set('body', '## Original Markdown\n\n- A change with its source link.')
  data.set('labels', ' history, improved, ,fixed ')
  data.set('segmentId', '')
  return data
}

test('editing an imported draft retains its ID and omits relationship/status defaults', () => {
  const parsed = parseChangelogForm(form())
  assert.equal(parsed.id, 'cl_Imported')
  assert.equal(parsed.projectId, 'proj_Synthetic')
  assert.equal(parsed.payload.title, 'Historical changes')
  assert.equal(parsed.payload.body, '## Original Markdown\n\n- A change with its source link.')
  assert.deepEqual(parsed.payload.labels, ['history', 'improved', 'fixed'])
  assert.equal(parsed.payload.segmentId, null)
  assert.equal(Object.hasOwn(parsed.payload, 'linkedPostIds'), false)
  assert.equal(Object.hasOwn(parsed.payload, 'status'), false)
})

test('new entries use the shared default draft schema and initialize linked posts', () => {
  const parsed = parseChangelogForm(form(false))
  assert.equal(parsed.id, null)
  assert.equal(parsed.payload.status, 'draft')
  assert.deepEqual(parsed.payload.linkedPostIds, [])
})

test('changelog dates survive ordinary saves and can be explicitly cleared', () => {
  const data = form()
  data.set('displayDate', '2026-08-16')
  assert.equal(parseChangelogForm(data).payload.displayDate, '2026-08-16')
  assert.equal(Object.hasOwn(parseChangelogForm(data).payload, 'status'), false)
  data.set('displayDate', '')
  assert.equal(parseChangelogForm(data).payload.displayDate, null)
  data.delete('displayDate')
  assert.equal(Object.hasOwn(parseChangelogForm(data).payload, 'displayDate'), false)
  const fresh = form(false)
  fresh.set('displayDate', '2026-08-24')
  assert.equal(parseChangelogForm(fresh).payload.displayDate, '2026-08-24')
})

test('invalid calendar dates cannot be saved through the editor', () => {
  for (const value of ['2026-02-30', '2026-2-1', 'not-a-date']) {
    const data = form()
    data.set('displayDate', value)
    assert.throws(() => parseChangelogForm(data), /content/)
  }
})

test('publishing or returning to draft requires one explicit publication intent', () => {
  for (const [name, expected] of [
    ['publish', 'published'],
    ['draft', 'draft'],
  ] as const) {
    const data = form()
    data.set(name, '1')
    const parsed = parseChangelogForm(data)
    assert.ok('status' in parsed.payload)
    assert.equal(parsed.payload.status, expected)
  }
  const ambiguous = form()
  ambiguous.set('publish', '1')
  ambiguous.set('draft', '1')
  assert.throws(() => parseChangelogForm(ambiguous), /publication intent/)
  for (const name of ['publish', 'draft']) {
    const invalid = form()
    invalid.set(name, 'false')
    assert.throws(() => parseChangelogForm(invalid), /publication intent/)
  }
})

test('ordinary published-entry saves do not echo stale status or accept hidden status/link changes', () => {
  const data = form()
  data.set('status', 'draft')
  data.set('linkedPostIds', '[]')
  const parsed = parseChangelogForm(data)
  assert.equal(Object.hasOwn(parsed.payload, 'status'), false)
  assert.equal(Object.hasOwn(parsed.payload, 'linkedPostIds'), false)
})

test('audience changes preserve an explicit segment and allow clearing to everyone', () => {
  const data = form()
  data.set('segmentId', 'seg_Synthetic')
  assert.equal(parseChangelogForm(data).payload.segmentId, 'seg_Synthetic')
  data.set('segmentId', '')
  assert.equal(parseChangelogForm(data).payload.segmentId, null)
})

test('malformed targets or audiences are rejected instead of creating another entry', () => {
  for (const [name, value] of [
    ['projectId', 'other_project'],
    ['id', ''],
    ['id', 'other_entry'],
    ['segmentId', 'other_segment'],
  ] as const) {
    const data = form()
    data.set(name, value)
    assert.throws(() => parseChangelogForm(data))
  }
})

test('required text is not silently replaced and a blank title is invalid', () => {
  for (const name of ['projectId', 'title', 'body', 'labels', 'segmentId']) {
    const data = form()
    data.delete(name)
    assert.throws(() => parseChangelogForm(data))
  }
  const blank = form()
  blank.set('title', ' \n\t ')
  assert.throws(() => parseChangelogForm(blank), /content/)
  const emptyBody = form()
  emptyBody.set('body', '')
  assert.equal(parseChangelogForm(emptyBody).payload.body, '')
})

test('files and duplicate scalar fields cannot be coerced into a save', () => {
  for (const name of [
    'projectId',
    'id',
    'title',
    'body',
    'labels',
    'segmentId',
    'displayDate',
    'publish',
    'draft',
  ]) {
    const file = form()
    file.set(name, new Blob(['synthetic file']), 'fixture.txt')
    assert.throws(() => parseChangelogForm(file), /Invalid changelog field/)
    const duplicate = form()
    if (!duplicate.has(name)) duplicate.set(name, '1')
    duplicate.append(name, 'another value')
    assert.throws(() => parseChangelogForm(duplicate), /Invalid changelog field/)
  }
})
