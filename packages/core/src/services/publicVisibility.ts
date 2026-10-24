import { and, boards, db, eq, inArray, isNull, posts } from '@chorala/db'
import { notFound } from '../errors.ts'

/** One visibility rule for every public list, detail and interaction surface. */
export function publicPostFilter(projectId: string) {
  return and(
    eq(posts.projectId, projectId),
    eq(posts.reviewStatus, 'none'),
    isNull(posts.hiddenAt),
    inArray(
      posts.boardId,
      db
        .select({ id: boards.id })
        .from(boards)
        .where(and(eq(boards.projectId, projectId), eq(boards.isPrivate, false))),
    ),
  )
}

/** Known IDs do not grant access to private boards, hidden posts or AI drafts. */
export async function assertPublicPost(projectId: string, postId: string) {
  const [post] = await db
    .select({ id: posts.id, projectId: posts.projectId, mergedIntoPostId: posts.mergedIntoPostId })
    .from(posts)
    .where(and(eq(posts.id, postId), publicPostFilter(projectId)))
  if (!post) throw notFound('Post')
  return post
}
