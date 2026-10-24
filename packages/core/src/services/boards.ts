import { and, asc, boards, db, eq, newId } from '@chorala/db'
import type { CreateBoardInput, UpdateBoardInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { conflict, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

export async function listBoards(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db
    .select()
    .from(boards)
    .where(eq(boards.projectId, projectId))
    .orderBy(asc(boards.position))
}

export async function getBoard(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select()
    .from(boards)
    .where(and(eq(boards.id, id), eq(boards.projectId, projectId)))
  if (!row) throw notFound('Board')
  return row
}

export async function createBoard(ctx: AuthContext, projectId: string, input: CreateBoardInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [dupe] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(and(eq(boards.projectId, projectId), eq(boards.slug, input.slug)))
  if (dupe) throw conflict(`A board with slug "${input.slug}" already exists`)

  const [row] = await db
    .insert(boards)
    .values({
      id: newId('board'),
      projectId,
      slug: input.slug,
      name: input.name,
      description: input.description,
      kind: input.kind,
      isPrivate: input.isPrivate,
    })
    .returning()
  return row
}

export async function updateBoard(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateBoardInput,
) {
  assertPermission(ctx, 'write')
  await getBoard(ctx, projectId, id)
  const [row] = await db
    .update(boards)
    .set({
      name: input.name,
      slug: input.slug,
      description: input.description,
      kind: input.kind,
      isPrivate: input.isPrivate,
    })
    .where(eq(boards.id, id))
    .returning()
  return row
}

export async function deleteBoard(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getBoard(ctx, projectId, id)
  await db.delete(boards).where(eq(boards.id, id))
  return { id, deleted: true }
}
