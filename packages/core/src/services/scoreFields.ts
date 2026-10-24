import { and, asc, db, eq, newId, scoreFields } from '@chorala/db'
import type { CreateScoreFieldInput, UpdateScoreFieldInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

/** Weighted prioritization fields for a project, in display order. */
export async function listScoreFields(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db
    .select()
    .from(scoreFields)
    .where(eq(scoreFields.projectId, projectId))
    .orderBy(asc(scoreFields.position), asc(scoreFields.createdAt))
}

/** Lightweight (key, weight) map used to compute a post's score — no auth (internal). */
export async function scoreWeights(projectId: string): Promise<{ key: string; weight: number }[]> {
  return db
    .select({ key: scoreFields.key, weight: scoreFields.weight })
    .from(scoreFields)
    .where(eq(scoreFields.projectId, projectId))
}

export async function createScoreField(
  ctx: AuthContext,
  projectId: string,
  input: CreateScoreFieldInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [dupe] = await db
    .select({ id: scoreFields.id })
    .from(scoreFields)
    .where(and(eq(scoreFields.projectId, projectId), eq(scoreFields.key, input.key)))
  if (dupe) throw conflict(`A score field with key "${input.key}" already exists`)
  const [row] = await db
    .insert(scoreFields)
    .values({
      id: newId('scoreField'),
      projectId,
      key: input.key,
      label: input.label,
      weight: input.weight,
      position: input.position ?? 0,
    })
    .returning()
  if (!row) throw badRequest('Failed to create score field')
  return row
}

export async function updateScoreField(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateScoreFieldInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [row] = await db
    .update(scoreFields)
    .set({
      key: input.key,
      label: input.label,
      weight: input.weight,
      position: input.position,
    })
    .where(and(eq(scoreFields.id, id), eq(scoreFields.projectId, projectId)))
    .returning()
  if (!row) throw notFound('Score field')
  return row
}

export async function deleteScoreField(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [row] = await db
    .delete(scoreFields)
    .where(and(eq(scoreFields.id, id), eq(scoreFields.projectId, projectId)))
    .returning({ id: scoreFields.id })
  if (!row) throw notFound('Score field')
  return { id: row.id, deleted: true }
}

/** Weighted score for a post: Σ (fields[key] × weight). Negative weights model cost inputs. */
export function computeScore(
  fields: Record<string, number>,
  weights: { key: string; weight: number }[],
): number {
  let score = 0
  for (const { key, weight } of weights) {
    const v = fields[key]
    if (typeof v === 'number' && Number.isFinite(v)) score += v * weight
  }
  return Math.round(score * 100) / 100
}
