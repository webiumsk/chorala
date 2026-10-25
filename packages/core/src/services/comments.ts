import { and, asc, comments, db, eq, isNull, newId, posts, sql } from '@chorala/db'
import { type AuthContext, assertPermission } from '../context.ts'
import { notFound } from '../errors.ts'
import { enqueueNotification, enqueueWebhookEvent } from '../queues.ts'
import { getProject } from './projects.ts'

type CommentAuthor = { endUserId?: string; memberId?: string }

async function assertPostInProject(projectId: string, postId: string) {
  const [post] = await db
    .select({ id: posts.id, projectId: posts.projectId })
    .from(posts)
    .where(eq(posts.id, postId))
  if (!post || post.projectId !== projectId) throw notFound('Post')
  return post
}

async function recountComments(postId: string) {
  await db
    .update(posts)
    .set({
      commentCount: sql`(select count(*)::int from ${comments} where ${comments.postId} = ${postId} and ${comments.isInternal} = false and ${comments.hiddenAt} is null)`,
    })
    .where(eq(posts.id, postId))
}

export async function listComments(
  projectId: string,
  postId: string,
  opts: { includeInternal?: boolean; includeHidden?: boolean } = {},
) {
  await assertPostInProject(projectId, postId)
  const filters = [eq(comments.postId, postId)]
  if (!opts.includeInternal) filters.push(eq(comments.isInternal, false))
  // Public threads (and the admin view by default) exclude moderator-hidden comments.
  if (!opts.includeHidden) filters.push(isNull(comments.hiddenAt))
  return db
    .select()
    .from(comments)
    .where(and(...filters))
    .orderBy(asc(comments.createdAt))
}

export async function createComment(
  projectId: string,
  postId: string,
  input: { body: string; parentCommentId?: string; isInternal?: boolean },
  author: CommentAuthor,
) {
  await assertPostInProject(projectId, postId)
  if (input.parentCommentId) {
    const [parent] = await db
      .select({ id: comments.id, isInternal: comments.isInternal, hiddenAt: comments.hiddenAt })
      .from(comments)
      .where(and(eq(comments.id, input.parentCommentId), eq(comments.postId, postId)))
    if (!parent || (author.endUserId && (parent.isInternal || parent.hiddenAt))) {
      throw notFound('Comment')
    }
  }
  const id = newId('comment')
  const [row] = await db
    .insert(comments)
    .values({
      id,
      postId,
      body: input.body,
      parentCommentId: input.parentCommentId,
      isInternal: input.isInternal ?? false,
      authorEndUserId: author.endUserId,
      authorMemberId: author.memberId,
    })
    .returning()
  await recountComments(postId)
  // Public comments fire a webhook; internal staff notes do not.
  if (!input.isInternal) {
    await enqueueWebhookEvent(projectId, 'comment.created', { postId, commentId: id })
    await enqueueNotification('comment-created', { projectId, postId, commentId: id })
  }
  return row
}

export async function deleteComment(projectId: string, postId: string, id: string) {
  await assertPostInProject(projectId, postId)
  const [row] = await db.select().from(comments).where(eq(comments.id, id))
  if (!row || row.postId !== postId) throw notFound('Comment')
  await db.delete(comments).where(eq(comments.id, id))
  await recountComments(postId)
  return { id, deleted: true }
}

/** Staff comment reads must authorize the organization before exposing internal notes. */
export async function listAdminComments(
  ctx: AuthContext,
  projectId: string,
  postId: string,
  opts: { includeHidden?: boolean } = {},
) {
  assertPermission(ctx, 'read')
  await getProject(ctx, projectId)
  return listComments(projectId, postId, { ...opts, includeInternal: true })
}

/** Use the same authoritative scope check from HTTP routes and dashboard actions. */
export async function createAdminComment(
  ctx: AuthContext,
  projectId: string,
  postId: string,
  input: { body: string; parentCommentId?: string; isInternal?: boolean },
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  return createComment(projectId, postId, input, { memberId: ctx.memberId })
}

export async function deleteAdminComment(
  ctx: AuthContext,
  projectId: string,
  postId: string,
  id: string,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  return deleteComment(projectId, postId, id)
}
