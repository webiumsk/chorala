import { asc, db, eq, newId, statuses } from '@chorala/db'
import type { CreateStatusInput, UpdateStatusInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { notFound } from '../errors.ts'
import { getProject } from './projects.ts'

export async function listStatuses(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db
    .select()
    .from(statuses)
    .where(eq(statuses.projectId, projectId))
    .orderBy(asc(statuses.position))
}

async function getStatusRow(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db.select().from(statuses).where(eq(statuses.id, id))
  if (!row || row.projectId !== projectId) throw notFound('Status')
  return row
}

export async function createStatus(ctx: AuthContext, projectId: string, input: CreateStatusInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const existing = await db.select().from(statuses).where(eq(statuses.projectId, projectId))
  const position = input.position ?? existing.length
  const [row] = await db
    .insert(statuses)
    .values({
      id: newId('status'),
      projectId,
      name: input.name,
      color: input.color,
      kind: input.kind,
      showOnRoadmap: input.showOnRoadmap,
      position,
    })
    .returning()
  return row
}

export async function updateStatus(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateStatusInput,
) {
  assertPermission(ctx, 'write')
  await getStatusRow(ctx, projectId, id)
  const [row] = await db
    .update(statuses)
    .set({
      name: input.name,
      color: input.color,
      kind: input.kind,
      showOnRoadmap: input.showOnRoadmap,
      position: input.position,
    })
    .where(eq(statuses.id, id))
    .returning()
  return row
}

export async function deleteStatus(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getStatusRow(ctx, projectId, id)
  await db.delete(statuses).where(eq(statuses.id, id))
  return { id, deleted: true }
}
