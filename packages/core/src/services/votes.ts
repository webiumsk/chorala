import { and, db, endUsers, eq, isNull, newId, or, posts, sql, votes } from '@chorala/db'
import type { VoteForInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { enqueueWebhookEvent } from '../queues.ts'
import { getProject } from './projects.ts'
import { assertPublicPost } from './publicVisibility.ts'

async function voteTarget(
  projectId: string,
  postId: string,
  endUserId: string,
  publicOnly: boolean,
) {
  const [endUser] = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.id, endUserId), eq(endUsers.projectId, projectId)))
  if (!endUser) throw notFound('End user')

  const [post] = await db
    .select({ id: posts.id, projectId: posts.projectId, mergedIntoPostId: posts.mergedIntoPostId })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.projectId, projectId)))
  if (!post) throw notFound('Post')
  const canonicalId = post.mergedIntoPostId ?? post.id
  if (publicOnly) {
    await assertPublicPost(projectId, postId)
    if (canonicalId !== postId) await assertPublicPost(projectId, canonicalId)
  } else if (canonicalId !== postId) {
    const [canonical] = await db
      .select({ id: posts.id })
      .from(posts)
      .where(and(eq(posts.id, canonicalId), eq(posts.projectId, projectId)))
    if (!canonical) throw notFound('Post')
  }
  return canonicalId
}

/**
 * Toggle an end-user's vote on a post. Votes always attach to the **canonical** post
 * (if `postId` was merged into another, the vote lands on the target) so cross-language
 * and duplicate ideas accumulate votes together (SPEC §11).
 */
export async function toggleVote(projectId: string, postId: string, endUserId: string) {
  const canonicalId = await voteTarget(projectId, postId, endUserId, true)

  const [existing] = await db
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.postId, canonicalId), eq(votes.endUserId, endUserId)))

  let voted: boolean
  if (existing) {
    await db.delete(votes).where(eq(votes.id, existing.id))
    voted = false
  } else {
    await db.insert(votes).values({ id: newId('vote'), postId: canonicalId, endUserId })
    voted = true
    await enqueueWebhookEvent(projectId, 'vote.created', { postId: canonicalId, endUserId })
  }

  const [row] = await db
    .update(posts)
    .set({
      voteCount: sql`(select count(*)::int from ${votes} where ${votes.postId} = ${canonicalId})`,
    })
    .where(eq(posts.id, canonicalId))
    .returning({ voteCount: posts.voteCount })

  return { voted, voteCount: row?.voteCount ?? 0 }
}

/** Explicitly set a vote on/off (POST /vote vs DELETE /vote). Canonical-post aware. */
export async function setVote(
  projectId: string,
  postId: string,
  endUserId: string,
  shouldVote: boolean,
  publicOnly = true,
) {
  const canonicalId = await voteTarget(projectId, postId, endUserId, publicOnly)

  const [existing] = await db
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.postId, canonicalId), eq(votes.endUserId, endUserId)))

  if (shouldVote && !existing) {
    await db.insert(votes).values({ id: newId('vote'), postId: canonicalId, endUserId })
    await enqueueWebhookEvent(projectId, 'vote.created', { postId: canonicalId, endUserId })
  } else if (!shouldVote && existing) {
    await db.delete(votes).where(eq(votes.id, existing.id))
  }

  const [row] = await db
    .update(posts)
    .set({
      voteCount: sql`(select count(*)::int from ${votes} where ${votes.postId} = ${canonicalId})`,
    })
    .where(eq(posts.id, canonicalId))
    .returning({ voteCount: posts.voteCount })

  return { voted: shouldVote, voteCount: row?.voteCount ?? 0 }
}

/**
 * Admin casts a vote on a post on behalf of a customer (sales/support logging a request).
 * Resolves the end-user by externalId or email, creating an identified one if needed, then
 * records the vote. Idempotent — a duplicate vote for the same user is a no-op.
 */
export async function voteForUser(
  ctx: AuthContext,
  projectId: string,
  postId: string,
  input: VoteForInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  if (!input.email && !input.externalId) throw badRequest('Provide an email or externalId')

  const match = or(
    input.externalId ? eq(endUsers.externalId, input.externalId) : undefined,
    input.email ? eq(endUsers.email, input.email) : undefined,
  )
  const [existing] = await db
    .select({ id: endUsers.id })
    .from(endUsers)
    .where(and(eq(endUsers.projectId, projectId), match ?? isNull(endUsers.id)))

  let endUserId = existing?.id
  if (!endUserId) {
    const [created] = await db
      .insert(endUsers)
      .values({
        id: newId('endUser'),
        projectId,
        externalId: input.externalId,
        email: input.email,
        name: input.name,
        isAnonymous: false,
      })
      .returning({ id: endUsers.id })
    if (!created) throw badRequest('Failed to create end user')
    endUserId = created.id
  }

  return setVote(projectId, postId, endUserId, true, false)
}

export async function hasVoted(postId: string, endUserId: string) {
  const [row] = await db
    .select({ id: votes.id })
    .from(votes)
    .where(and(eq(votes.postId, postId), eq(votes.endUserId, endUserId)))
  return !!row
}
