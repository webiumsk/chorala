import { randomUUID } from 'node:crypto'
import {
  changelogEntries,
  client,
  db,
  eq,
  newId,
  organizations,
  projects,
  segments,
} from '@chorala/db'
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthContext } from '../src/context.ts'
import { enqueueNotification, enqueueWebhookEvent } from '../src/queues.ts'
import { getChangelog, updateChangelog } from '../src/services/changelog.ts'

vi.mock('../src/queues.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/queues.ts')>()),
  enqueueNotification: vi.fn(async () => {}),
  enqueueWebhookEvent: vi.fn(async () => {}),
}))

let orgId: string
let projectId: string
let otherProjectId: string
let segmentId: string
let ctx: AuthContext

beforeAll(async () => {
  orgId = newId('organization')
  const slug = `changelog-${randomUUID().slice(0, 8)}`
  await db.insert(organizations).values({ id: orgId, slug, name: 'Synthetic Changelog Org' })
  projectId = newId('project')
  otherProjectId = newId('project')
  await db.insert(projects).values(
    [projectId, otherProjectId].map((id, index) => ({
      id,
      orgId,
      slug: `${slug}-${index}`,
      name: 'Synthetic Changelog Project',
      publicKey: `pk_${randomUUID()}`,
      endUserJwtSecret: 'synthetic_changelog_signing_secret_not_for_production',
    })),
  )
  segmentId = newId('segment')
  await db.insert(segments).values({
    id: segmentId,
    projectId,
    name: 'Synthetic audience',
    definition: { match: 'all', rules: [] },
  })
  ctx = { kind: 'session', orgId, role: 'owner' }
})

beforeEach(() => {
  vi.mocked(enqueueNotification).mockClear()
  vi.mocked(enqueueWebhookEvent).mockClear()
})

afterAll(async () => {
  if (orgId) await db.delete(organizations).where(eq(organizations.id, orgId))
  await client.end()
})

async function draft() {
  const id = newId('changelogEntry')
  await db.insert(changelogEntries).values({
    id,
    projectId,
    title: 'Imported draft',
    body: 'Original historical Markdown',
    linkedPostIds: ['post_SyntheticRetainedLink'],
    segmentId,
    labels: ['history'],
  })
  return id
}

describe('editing and publishing existing changelogs', () => {
  test('ordinary edits preserve relationships, audience and draft status without delivery', async () => {
    const id = await draft()
    const updated = await updateChangelog(ctx, projectId, id, { title: 'Reviewed title' })
    expect(updated?.id).toBe(id)
    expect(updated?.status).toBe('draft')
    expect(updated?.linkedPostIds).toEqual(['post_SyntheticRetainedLink'])
    expect(updated?.segmentId).toBe(segmentId)
    expect(updated?.publishedAt).toBeNull()
    expect(enqueueNotification).not.toHaveBeenCalled()
    expect(enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  test('parallel publication schedules one transition and repeated published edits do not resend', async () => {
    const id = await draft()
    const results = await Promise.all(
      Array.from({ length: 8 }, () => updateChangelog(ctx, projectId, id, { status: 'published' })),
    )
    expect(results.every((entry) => entry?.status === 'published')).toBe(true)
    expect(enqueueNotification).toHaveBeenCalledTimes(1)
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1)
    const originalDate = (await getChangelog(ctx, projectId, id)).publishedAt
    await updateChangelog(ctx, projectId, id, { title: 'Published correction' })
    const updated = await getChangelog(ctx, projectId, id)
    expect(updated.status).toBe('published')
    expect(updated.publishedAt).toEqual(originalDate)
    expect(updated.linkedPostIds).toEqual(['post_SyntheticRetainedLink'])
    expect(enqueueNotification).toHaveBeenCalledTimes(1)
    expect(enqueueWebhookEvent).toHaveBeenCalledTimes(1)
  })

  test('read-only staff and foreign project or organization targets cannot publish', async () => {
    const id = await draft()
    await expect(
      updateChangelog({ ...ctx, role: 'member' }, projectId, id, { status: 'published' }),
    ).rejects.toThrow('Missing write permission')
    await expect(updateChangelog(ctx, otherProjectId, id, { status: 'published' })).rejects.toThrow(
      'Changelog entry',
    )
    await expect(
      updateChangelog({ ...ctx, orgId: 'org_Unrelated' }, projectId, id, { status: 'published' }),
    ).rejects.toThrow('Project')
    expect((await getChangelog(ctx, projectId, id)).status).toBe('draft')
    expect(enqueueNotification).not.toHaveBeenCalled()
    expect(enqueueWebhookEvent).not.toHaveBeenCalled()
  })

  test('audience can be explicitly cleared without dropping linked posts', async () => {
    const id = await draft()
    const updated = await updateChangelog(ctx, projectId, id, { segmentId: null })
    expect(updated?.segmentId).toBeNull()
    expect(updated?.linkedPostIds).toEqual(['post_SyntheticRetainedLink'])
    expect(updated?.status).toBe('draft')
  })
})
