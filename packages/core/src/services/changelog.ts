import { and, changelogEntries, db, desc, eq, newId } from '@chorala/db'
import type { CreateChangelogInput, UpdateChangelogInput } from '@chorala/types'
import { newestChangelogFirst } from '../changelog-order.ts'
import { type AuthContext, assertPermission } from '../context.ts'
import { notFound } from '../errors.ts'
import { enqueueNotification, enqueueWebhookEvent } from '../queues.ts'
import { getPost } from './posts.ts'
import { getProject } from './projects.ts'
import { getSegment } from './segments.ts'

export async function listChangelog(
  ctx: AuthContext,
  projectId: string,
  opts: { publishedOnly?: boolean } = {},
) {
  await getProject(ctx, projectId)
  const filters = [eq(changelogEntries.projectId, projectId)]
  if (opts.publishedOnly) filters.push(eq(changelogEntries.status, 'published'))
  const entries = await db
    .select()
    .from(changelogEntries)
    .where(and(...filters))
    .orderBy(desc(changelogEntries.publishedAt), desc(changelogEntries.createdAt))
  return newestChangelogFirst(entries)
}

async function getEntry(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db.select().from(changelogEntries).where(eq(changelogEntries.id, id))
  if (!row || row.projectId !== projectId) throw notFound('Changelog entry')
  return row
}

export const getChangelog = getEntry

export async function createChangelog(
  ctx: AuthContext,
  projectId: string,
  input: CreateChangelogInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  for (const postId of input.linkedPostIds) await getPost(ctx, projectId, postId)
  if (input.segmentId) await getSegment(ctx, projectId, input.segmentId)
  const [row] = await db
    .insert(changelogEntries)
    .values({
      id: newId('changelogEntry'),
      projectId,
      title: input.title,
      body: input.body,
      status: input.status,
      labels: input.labels,
      linkedPostIds: input.linkedPostIds,
      segmentId: input.segmentId ?? null,
      publishedAt: input.status === 'published' ? new Date() : null,
    })
    .returning()
  if (row?.status === 'published') {
    await enqueueWebhookEvent(projectId, 'changelog.published', { changelogId: row.id })
    await enqueueNotification('changelog-published', { projectId, changelogId: row.id })
  }
  return row
}

export async function updateChangelog(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateChangelogInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  for (const postId of input.linkedPostIds ?? []) await getPost(ctx, projectId, postId)
  if (input.segmentId) await getSegment(ctx, projectId, input.segmentId)
  const { row, becomingPublished } = await db.transaction(async (tx) => {
    // Serialize concurrent saves so only the request that actually transitions
    // a draft to published schedules publication delivery.
    const [existing] = await tx
      .select()
      .from(changelogEntries)
      .where(and(eq(changelogEntries.id, id), eq(changelogEntries.projectId, projectId)))
      .for('update')
    if (!existing) throw notFound('Changelog entry')
    const becomingPublished = input.status === 'published' && existing.status !== 'published'
    const [row] = await tx
      .update(changelogEntries)
      .set({
        title: input.title,
        body: input.body,
        status: input.status,
        labels: input.labels,
        linkedPostIds: input.linkedPostIds,
        segmentId: input.segmentId === undefined ? undefined : input.segmentId,
        publishedAt: becomingPublished ? new Date() : undefined,
      })
      .where(and(eq(changelogEntries.id, id), eq(changelogEntries.projectId, projectId)))
      .returning()
    return { row, becomingPublished }
  })
  if (becomingPublished) {
    await enqueueWebhookEvent(projectId, 'changelog.published', { changelogId: id })
    await enqueueNotification('changelog-published', { projectId, changelogId: id })
  }
  return row
}

export async function deleteChangelog(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getEntry(ctx, projectId, id)
  await db.delete(changelogEntries).where(eq(changelogEntries.id, id))
  return { id, deleted: true }
}
