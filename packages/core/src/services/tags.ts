import { and, db, eq, newId, posts, postTags, tags } from '@chorala/db'
import type { CreateTagInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { conflict, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

export async function listTags(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db.select().from(tags).where(eq(tags.projectId, projectId))
}

/** Tags currently attached to a post. */
export async function listPostTags(ctx: AuthContext, projectId: string, postId: string) {
  await getProject(ctx, projectId)
  const [post] = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.projectId, projectId)))
  if (!post) throw notFound('Post')
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(and(eq(postTags.postId, postId), eq(tags.projectId, projectId)))
}

export async function createTag(ctx: AuthContext, projectId: string, input: CreateTagInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [dupe] = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.projectId, projectId), eq(tags.name, input.name)))
  if (dupe) throw conflict(`Tag "${input.name}" already exists`)
  const [row] = await db
    .insert(tags)
    .values({ id: newId('tag'), projectId, name: input.name, color: input.color })
    .returning()
  return row
}

export async function deleteTag(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [row] = await db.select().from(tags).where(eq(tags.id, id))
  if (!row || row.projectId !== projectId) throw notFound('Tag')
  await db.delete(tags).where(eq(tags.id, id))
  return { id, deleted: true }
}

/**
 * Auto-categorize (Phase 20): attach any of the project's existing tags whose name appears as a
 * word in `text` to `postId`. Deterministic (no AI) and idempotent — used at submit time so new
 * feedback lands pre-tagged. Returns the tag ids that were applied.
 */
export async function autoTagPost(projectId: string, postId: string, text: string) {
  const hay = (text ?? '').toLowerCase()
  if (!hay.trim()) return []
  const projectTags = await db
    .select({ id: tags.id, name: tags.name })
    .from(tags)
    .where(eq(tags.projectId, projectId))
  const matched = projectTags.filter((t) => {
    const name = t.name.toLowerCase()
    return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(hay)
  })
  if (matched.length === 0) return []
  const existing = await db
    .select({ tagId: postTags.tagId })
    .from(postTags)
    .where(eq(postTags.postId, postId))
  const have = new Set(existing.map((r) => r.tagId))
  const toAdd = matched.filter((t) => !have.has(t.id))
  if (toAdd.length > 0) {
    await db.insert(postTags).values(toAdd.map((t) => ({ postId, tagId: t.id })))
  }
  return matched.map((t) => t.id)
}

/** Additively attach tags to a post (ignores ones already present). Validates project ownership. */
export async function addPostTags(projectId: string, postId: string, tagIds: string[]) {
  if (tagIds.length === 0) return []
  const valid = await db.select({ id: tags.id }).from(tags).where(eq(tags.projectId, projectId))
  const validIds = new Set(valid.map((t) => t.id))
  const existing = await db
    .select({ tagId: postTags.tagId })
    .from(postTags)
    .where(eq(postTags.postId, postId))
  const have = new Set(existing.map((r) => r.tagId))
  const toAdd = tagIds.filter((id) => validIds.has(id) && !have.has(id))
  if (toAdd.length > 0) {
    await db.insert(postTags).values(toAdd.map((tagId) => ({ postId, tagId })))
  }
  return toAdd
}

/** Replace a post's tag set (validates all tags belong to the project). */
export async function setPostTags(
  ctx: AuthContext,
  projectId: string,
  postId: string,
  tagIds: string[],
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [post] = await db
    .select({ id: posts.id, projectId: posts.projectId })
    .from(posts)
    .where(eq(posts.id, postId))
  if (!post || post.projectId !== projectId) throw notFound('Post')

  if (tagIds.length > 0) {
    const valid = await db.select({ id: tags.id }).from(tags).where(eq(tags.projectId, projectId))
    const validIds = new Set(valid.map((t) => t.id))
    for (const t of tagIds) if (!validIds.has(t)) throw notFound(`Tag ${t}`)
  }

  await db.delete(postTags).where(eq(postTags.postId, postId))
  if (tagIds.length > 0) {
    await db.insert(postTags).values(tagIds.map((tagId) => ({ postId, tagId })))
  }
  return { postId, tagIds }
}
