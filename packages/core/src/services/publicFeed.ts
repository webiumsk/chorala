import { analyzeSentiment } from '@chorala/ai'
import {
  and,
  asc,
  boards,
  changelogEntries,
  changelogSubscribers,
  comments,
  db,
  desc,
  eq,
  ilike,
  inArray,
  isNull,
  newId,
  notInArray,
  or,
  posts,
  postTags,
  postTranslations,
  sql,
  statuses,
  tags,
  votes,
} from '@chorala/db'
import type { CreateCommentInput, CreatePostInput, PostSort } from '@chorala/types'
import { newestChangelogFirst } from '../changelog-order.ts'
import { badRequest, notFound } from '../errors.ts'
import {
  enqueueGithubAutoCreate,
  enqueueNotification,
  enqueuePostProcessing,
  enqueueWebhookEvent,
} from '../queues.ts'
import { createComment, listComments } from './comments.ts'
import { detectSpam } from './moderation.ts'
import { postColumns } from './posts.ts'
import { assertPublicPost, publicPostFilter } from './publicVisibility.ts'
import { linkAttachmentsToPost } from './storage.ts'
import { autoTagPost } from './tags.ts'

type PostRow = Awaited<ReturnType<typeof getPostRows>>[number]

function orderFor(sort: PostSort) {
  switch (sort) {
    case 'new':
      return [desc(posts.createdAt)]
    case 'oldest':
      return [asc(posts.createdAt)]
    case 'trending':
      return [desc(posts.voteCount), desc(posts.createdAt)]
    default:
      return [desc(posts.isPinned), desc(posts.voteCount)]
  }
}

async function getPostRows(
  where: ReturnType<typeof and>,
  order: ReturnType<typeof desc>[],
  limit?: number,
) {
  const q = db
    .select(postColumns)
    .from(posts)
    .where(where)
    .orderBy(...order)
  return limit ? q.limit(limit) : q
}

/** Overlay localized title/body for `locale`, and mark `hasVoted` for `endUserId`. */
async function decorate(
  rows: PostRow[],
  locale: string | undefined,
  endUserId: string | undefined,
) {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r.id)

  const translations =
    locale && locale !== 'en'
      ? await db
          .select()
          .from(postTranslations)
          .where(and(inArray(postTranslations.postId, ids), eq(postTranslations.locale, locale)))
      : []
  const trMap = new Map(translations.map((t) => [t.postId, t]))

  const myVotes = endUserId
    ? await db
        .select({ postId: votes.postId })
        .from(votes)
        .where(and(inArray(votes.postId, ids), eq(votes.endUserId, endUserId)))
    : []
  const voted = new Set(myVotes.map((v) => v.postId))

  // Attach each post's status (name/color/kind) so public embedders can badge precisely.
  const statusIds = [...new Set(rows.map((r) => r.statusId).filter((s): s is string => !!s))]
  const statusRows = statusIds.length
    ? await db.select().from(statuses).where(inArray(statuses.id, statusIds))
    : []
  const statusMap = new Map(statusRows.map((s) => [s.id, s]))

  // Attach each post's tags (name/color) for topic chips on the portal/widget.
  const tagRows = await db
    .select({ postId: postTags.postId, name: tags.name, color: tags.color })
    .from(postTags)
    .innerJoin(tags, eq(tags.id, postTags.tagId))
    .where(inArray(postTags.postId, ids))
  const tagMap = new Map<string, { name: string; color: string }[]>()
  for (const t of tagRows) {
    const list = tagMap.get(t.postId) ?? []
    list.push({ name: t.name, color: t.color })
    tagMap.set(t.postId, list)
  }

  return rows.map((r) => {
    const tr = trMap.get(r.id)
    return {
      ...r,
      title: tr?.title ?? r.title,
      body: tr?.body ?? r.body,
      displayLocale: tr ? locale : r.originalLocale,
      hasVoted: endUserId ? voted.has(r.id) : undefined,
      status: r.statusId ? (statusMap.get(r.statusId) ?? null) : null,
      tags: tagMap.get(r.id) ?? [],
    }
  })
}

export type PublicListOpts = {
  boardSlug?: string
  statusId?: string
  tagId?: string
  sort?: PostSort
  locale?: string
  search?: string
  limit?: number
  endUserId?: string
}

export async function listPublicBoards(projectId: string, opts: PublicListOpts = {}) {
  const visibleBoards = await db
    .select()
    .from(boards)
    .where(and(eq(boards.projectId, projectId), eq(boards.isPrivate, false)))
    .orderBy(asc(boards.position))

  const filters = [publicPostFilter(projectId), sql`${posts.mergedIntoPostId} is null`]
  if (opts.boardSlug) {
    const board = visibleBoards.find((b) => b.slug === opts.boardSlug)
    if (!board) throw notFound('Board')
    filters.push(eq(posts.boardId, board.id))
  } else {
    filters.push(
      inArray(
        posts.boardId,
        visibleBoards.map((b) => b.id),
      ),
    )
  }
  if (opts.statusId) filters.push(eq(posts.statusId, opts.statusId))
  if (opts.tagId) {
    filters.push(
      inArray(
        posts.id,
        db.select({ id: postTags.postId }).from(postTags).where(eq(postTags.tagId, opts.tagId)),
      ),
    )
  }
  if (opts.search) {
    const term = `%${opts.search}%`
    const m = or(ilike(posts.title, term), ilike(posts.body, term))
    if (m) filters.push(m)
  }

  // Hide closed/declined posts from the public board — keep it to active + shipped ideas.
  const closedStatuses = await db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.kind, 'closed')))
  if (closedStatuses.length) {
    const notClosed = or(
      isNull(posts.statusId),
      notInArray(
        posts.statusId,
        closedStatuses.map((s) => s.id),
      ),
    )
    if (notClosed) filters.push(notClosed)
  }

  // Guard: no visible boards → no posts.
  if (visibleBoards.length === 0) return { boards: [], posts: [] }

  const rows = await getPostRows(and(...filters), orderFor(opts.sort ?? 'top'), opts.limit ?? 50)
  const decorated = await decorate(rows, opts.locale, opts.endUserId)
  return { boards: visibleBoards, posts: decorated }
}

export async function getPublicPost(
  projectId: string,
  postId: string,
  opts: { locale?: string; endUserId?: string } = {},
) {
  const [row] = await getPostRows(and(eq(posts.id, postId), publicPostFilter(projectId)), [
    desc(posts.createdAt),
  ])
  if (!row) throw notFound('Post')
  const [post] = await decorate([row], opts.locale, opts.endUserId)
  const publicComments = await listComments(projectId, postId, { includeInternal: false })
  const translations = await db
    .select()
    .from(postTranslations)
    .where(eq(postTranslations.postId, postId))
  return { post, comments: publicComments, translations }
}

export async function createPublicPost(
  projectId: string,
  endUserId: string,
  input: CreatePostInput,
) {
  const [board] = await db
    .select()
    .from(boards)
    .where(
      and(
        eq(boards.projectId, projectId),
        eq(boards.slug, input.boardSlug),
        eq(boards.isPrivate, false),
      ),
    )
  if (!board) throw notFound('Board')

  const [openStatus] = await db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.kind, 'open')))
    .orderBy(asc(statuses.position))

  const id = newId('post')
  const text = `${input.title}\n${input.body ?? ''}`
  // AI depth (Phase 20): deterministic lexicon sentiment at submit time, so every post is scored
  // even with provider=none. The worker refines it with the LLM when one is configured.
  const sent = analyzeSentiment(text)
  await db.insert(posts).values({
    id,
    projectId,
    boardId: board.id,
    authorEndUserId: endUserId,
    title: input.title,
    body: input.body,
    originalLocale: input.locale ?? 'en',
    statusId: openStatus?.id,
    // Structured submission context (Sentry/Canny style). `appVersion` is promoted to a
    // first-class, filterable column; everything else lands in the admin-only `context` map.
    appVersion: input.appVersion,
    context: input.metadata ?? {},
    // Moderation: cheap spam heuristic flags suspicious submissions for the queue (still
    // visible — a human decides). No auto-hide, so false positives never silence real users.
    flaggedReason: detectSpam(text),
    sentiment: sent.score,
    sentimentLabel: sent.label,
  })
  // Link any screenshots uploaded just before submit (scoped to this end-user + project).
  if (input.attachmentIds?.length) {
    await linkAttachmentsToPost(projectId, endUserId, input.attachmentIds, id)
  }
  // Auto-categorize: attach any existing project tags whose name appears in the text.
  await autoTagPost(projectId, id, text)
  // AI: embed + dedup + translate + sentiment refine (no-op when AI is disabled); fire webhook.
  await enqueuePostProcessing(id)
  await enqueueWebhookEvent(projectId, 'post.created', { postId: id, boardId: board.id })
  await enqueueNotification('post-created', { projectId, postId: id })
  await enqueueGithubAutoCreate(projectId, id)
  return getPublicPost(projectId, id, { locale: input.locale, endUserId })
}

export async function addPublicComment(
  projectId: string,
  postId: string,
  endUserId: string,
  input: CreateCommentInput,
) {
  await assertPublicPost(projectId, postId)
  // Public commenters can never post internal staff notes.
  const row = await createComment(
    projectId,
    postId,
    { body: input.body, parentCommentId: input.parentCommentId, isInternal: false },
    { endUserId },
  )
  // Flag spammy comments for the moderation queue (kept visible until a human acts).
  const reason = detectSpam(input.body)
  if (reason && row) {
    await db.update(comments).set({ flaggedReason: reason }).where(eq(comments.id, row.id))
  }
  return row
}

export async function getRoadmap(
  projectId: string,
  opts: { locale?: string; endUserId?: string } = {},
) {
  const roadmapStatuses = await db
    .select()
    .from(statuses)
    .where(and(eq(statuses.projectId, projectId), eq(statuses.showOnRoadmap, true)))
    .orderBy(asc(statuses.position))

  const columns = []
  for (const status of roadmapStatuses) {
    const rows = await getPostRows(
      and(
        publicPostFilter(projectId),
        eq(posts.statusId, status.id),
        sql`${posts.mergedIntoPostId} is null`,
      ),
      [desc(posts.voteCount)],
      50,
    )
    columns.push({ status, posts: await decorate(rows, opts.locale, opts.endUserId) })
  }
  return { columns }
}

export async function getPublicChangelog(projectId: string) {
  const entries = await db
    .select()
    .from(changelogEntries)
    .where(and(eq(changelogEntries.projectId, projectId), eq(changelogEntries.status, 'published')))
    .orderBy(desc(changelogEntries.publishedAt))
  return newestChangelogFirst(entries)
}

export async function subscribeChangelog(projectId: string, email: string, endUserId?: string) {
  const [existing] = await db
    .select()
    .from(changelogSubscribers)
    .where(
      and(eq(changelogSubscribers.projectId, projectId), eq(changelogSubscribers.email, email)),
    )
  if (existing) return existing
  const [row] = await db
    .insert(changelogSubscribers)
    .values({ id: newId('changelogSubscriber'), projectId, email, endUserId })
    .returning()
  if (!row) throw badRequest('Failed to subscribe')
  return row
}
