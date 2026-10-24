import { and, comments, db, desc, endUsers, eq, isNotNull, or, posts, sql } from '@chorala/db'
import { type AuthContext, canModerate } from '../context.ts'
import { badRequest, forbidden, notFound } from '../errors.ts'
import { recordAudit } from './audit.ts'
import { getProject } from './projects.ts'

/**
 * Lightweight, deterministic spam heuristic (no AI required). Returns a short reason string
 * when the text looks like spam, else null. Conservative on purpose — it only *flags* content
 * for a human; it never auto-deletes. Tunable thresholds in one place.
 */
export function detectSpam(text: string): string | null {
  const t = (text ?? '').trim()
  if (!t) return null
  const urls = t.match(/https?:\/\/\S+/gi) ?? []
  if (urls.length >= 4) return 'Excessive links'
  const lower = t.toLowerCase()
  const KEYWORDS = [
    'viagra',
    'casino',
    'porn',
    'crypto giveaway',
    'free money',
    'work from home',
    'buy now',
    'limited offer',
    'click here',
    'seo service',
    'cheap loan',
  ]
  const hit = KEYWORDS.find((k) => lower.includes(k))
  if (hit) return `Spam keyword: ${hit}`
  // A wall of CAPS on a reasonably long message reads as shouting/spam.
  const letters = t.replace(/[^a-z]/gi, '')
  if (letters.length >= 20 && letters === letters.toUpperCase()) return 'All-caps shouting'
  // The same word repeated many times (keyword stuffing).
  const words = lower.split(/\s+/).filter(Boolean)
  if (words.length >= 8) {
    const counts = new Map<string, number>()
    for (const w of words) counts.set(w, (counts.get(w) ?? 0) + 1)
    const top = Math.max(...counts.values())
    if (top / words.length > 0.5) return 'Repeated text'
  }
  return null
}

/** The flagged-or-hidden posts + comments awaiting a moderator's decision. */
export async function listModerationQueue(ctx: AuthContext, projectId: string) {
  if (!canModerate(ctx)) throw forbidden('You do not have moderation access')
  await getProject(ctx, projectId)

  const flaggedPosts = await db
    .select({
      id: posts.id,
      title: posts.title,
      body: posts.body,
      flaggedReason: posts.flaggedReason,
      hiddenAt: posts.hiddenAt,
      createdAt: posts.createdAt,
      authorEmail: endUsers.email,
    })
    .from(posts)
    .leftJoin(endUsers, eq(endUsers.id, posts.authorEndUserId))
    .where(
      and(
        eq(posts.projectId, projectId),
        or(isNotNull(posts.flaggedReason), isNotNull(posts.hiddenAt)),
      ),
    )
    .orderBy(desc(posts.createdAt))

  const flaggedComments = await db
    .select({
      id: comments.id,
      postId: comments.postId,
      body: comments.body,
      flaggedReason: comments.flaggedReason,
      hiddenAt: comments.hiddenAt,
      createdAt: comments.createdAt,
      authorEmail: endUsers.email,
    })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .leftJoin(endUsers, eq(endUsers.id, comments.authorEndUserId))
    .where(
      and(
        eq(posts.projectId, projectId),
        or(isNotNull(comments.flaggedReason), isNotNull(comments.hiddenAt)),
      ),
    )
    .orderBy(desc(comments.createdAt))

  return { posts: flaggedPosts, comments: flaggedComments }
}

async function assertPostInProject(projectId: string, id: string) {
  const [row] = await db
    .select({ id: posts.id, projectId: posts.projectId })
    .from(posts)
    .where(eq(posts.id, id))
  if (!row || row.projectId !== projectId) throw notFound('Post')
}

async function assertCommentInProject(projectId: string, id: string) {
  const [row] = await db
    .select({ id: comments.id, postId: comments.postId })
    .from(comments)
    .innerJoin(posts, eq(posts.id, comments.postId))
    .where(and(eq(comments.id, id), eq(posts.projectId, projectId)))
  if (!row) throw notFound('Comment')
  return row.postId
}

/** Recount a post's *visible* public comments (excludes internal notes and hidden ones). */
async function recountVisibleComments(postId: string) {
  await db
    .update(posts)
    .set({
      commentCount: sql`(select count(*)::int from ${comments}
        where ${comments.postId} = ${postId}
          and ${comments.isInternal} = false
          and ${comments.hiddenAt} is null)`,
    })
    .where(eq(posts.id, postId))
}

export type ModerationAction = 'hide' | 'unhide' | 'approve'

/** Apply a moderation decision to a post: hide it, unhide it, or approve (clear the flag). */
export async function moderatePost(
  ctx: AuthContext,
  projectId: string,
  id: string,
  action: ModerationAction,
) {
  if (!canModerate(ctx)) throw forbidden('You do not have moderation access')
  await getProject(ctx, projectId)
  await assertPostInProject(projectId, id)
  const patch = patchFor(action)
  await db.update(posts).set(patch).where(eq(posts.id, id))
  await recordAudit(ctx, `post.${action}`, id, { projectId })
  return { id, ...patch, hiddenAt: patch.hiddenAt ?? null }
}

/** Apply a moderation decision to a comment (keeps the post's comment count in sync). */
export async function moderateComment(
  ctx: AuthContext,
  projectId: string,
  id: string,
  action: ModerationAction,
) {
  if (!canModerate(ctx)) throw forbidden('You do not have moderation access')
  await getProject(ctx, projectId)
  const postId = await assertCommentInProject(projectId, id)
  const patch = patchFor(action)
  await db.update(comments).set(patch).where(eq(comments.id, id))
  if (action !== 'approve') await recountVisibleComments(postId)
  await recordAudit(ctx, `comment.${action}`, id, { projectId, postId })
  return { id, ...patch, hiddenAt: patch.hiddenAt ?? null }
}

function patchFor(action: ModerationAction): { hiddenAt?: Date | null; flaggedReason: null } {
  switch (action) {
    case 'hide':
      return { hiddenAt: new Date(), flaggedReason: null }
    case 'unhide':
      return { hiddenAt: null, flaggedReason: null }
    case 'approve':
      // Keep it visible; just dismiss the flag so it leaves the queue.
      return { flaggedReason: null }
    default:
      throw badRequest('Unknown moderation action')
  }
}
