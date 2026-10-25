import { analyzeSentiment } from '@chorala/ai'
import {
  aiJobs,
  and,
  asc,
  boards,
  companies,
  db,
  desc,
  endUsers,
  eq,
  ilike,
  inArray,
  members,
  newId,
  or,
  posts,
  scoreFields,
  sql,
  statuses,
  votes,
} from '@chorala/db'
import type { AdminCreatePostInput, PostSort, UpdatePostInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, conflict, notFound } from '../errors.ts'
import {
  enqueueGithubAutoCreate,
  enqueueIntegrationSync,
  enqueueNotification,
  enqueuePostProcessing,
  enqueueWebhookEvent,
} from '../queues.ts'
import { recordAudit } from './audit.ts'
import { getProject } from './projects.ts'
import { computeScore, scoreWeights } from './scoreFields.ts'
import { autoTagPost } from './tags.ts'

/** Post columns excluding the (large, internal) embedding vector — never serialized to clients. */
export const postColumns = {
  id: posts.id,
  boardId: posts.boardId,
  projectId: posts.projectId,
  authorEndUserId: posts.authorEndUserId,
  authorMemberId: posts.authorMemberId,
  title: posts.title,
  body: posts.body,
  originalLocale: posts.originalLocale,
  statusId: posts.statusId,
  isPinned: posts.isPinned,
  voteCount: posts.voteCount,
  commentCount: posts.commentCount,
  mergedIntoPostId: posts.mergedIntoPostId,
  eta: posts.eta,
  appVersion: posts.appVersion,
  sentiment: posts.sentiment,
  sentimentLabel: posts.sentimentLabel,
  createdAt: posts.createdAt,
  updatedAt: posts.updatedAt,
}

/** Admin-only columns (owner + scoring inputs + review state) over the public-safe set. */
const adminPostColumns = {
  ...postColumns,
  assigneeMemberId: posts.assigneeMemberId,
  fields: posts.fields,
  reviewStatus: posts.reviewStatus,
  source: posts.source,
}

type ListOpts = {
  boardId?: string
  statusId?: string
  appVersion?: string
  /** Filter to posts authored by users of this company / plan / minimum account MRR. */
  companyId?: string
  plan?: string
  minMrr?: number
  assigneeMemberId?: string
  // Autopilot review state. Defaults to live posts only (`none`); pass 'pending' for the
  // review queue, or 'all' to include everything.
  reviewStatus?: 'none' | 'pending' | 'dismissed' | 'all'
  search?: string
  sort?: PostSort
  includeMerged?: boolean
}

/**
 * Revenue impact (Phase 11): Σ MRR of the *distinct* companies whose users voted for a post.
 * Distinct so a company with three voters counts its MRR once. Correlated to the outer row.
 */
// `"posts"."id"` is written as a literal (not ${posts.id}) so the correlation stays qualified
// in the SELECT projection too — drizzle renders an interpolated column unqualified there,
// which collides with the inner tables' own `id` columns ("column reference id is ambiguous").
const revenueImpactSql = sql<number>`coalesce((
  select sum(t.mrr)::int from (
    select distinct c.id, c.mrr
    from votes v
    join end_users eu on v.end_user_id = eu.id
    join companies c on eu.company_id = c.id
    where v.post_id = "posts"."id"
  ) t
), 0)`

function orderFor(sort: PostSort | undefined) {
  switch (sort) {
    case 'new':
      return [desc(posts.createdAt)]
    case 'oldest':
      return [asc(posts.createdAt)]
    case 'trending':
      return [desc(posts.voteCount), desc(posts.createdAt)]
    case 'revenue':
      return [sql`${revenueImpactSql} desc`, desc(posts.voteCount)]
    default:
      return [desc(posts.isPinned), desc(posts.voteCount)]
  }
}

// posts authored by a user whose company matches a predicate on the companies row
const byAuthorCompany = (pred: ReturnType<typeof sql>) =>
  sql`${posts.authorEndUserId} in (
    select eu.id from end_users eu join companies c on eu.company_id = c.id where ${pred}
  )`

export async function listPosts(ctx: AuthContext, projectId: string, opts: ListOpts = {}) {
  await getProject(ctx, projectId)
  const filters = [eq(posts.projectId, projectId)]
  if (opts.boardId) filters.push(eq(posts.boardId, opts.boardId))
  if (opts.statusId) filters.push(eq(posts.statusId, opts.statusId))
  if (opts.appVersion) filters.push(eq(posts.appVersion, opts.appVersion))
  if (opts.companyId) filters.push(byAuthorCompany(sql`c.id = ${opts.companyId}`))
  if (opts.plan) filters.push(byAuthorCompany(sql`c.plan = ${opts.plan}`))
  if (opts.minMrr) filters.push(byAuthorCompany(sql`c.mrr >= ${opts.minMrr}`))
  if (opts.assigneeMemberId) filters.push(eq(posts.assigneeMemberId, opts.assigneeMemberId))
  // Default to live posts; the review queue passes 'pending', dashboards can pass 'all'.
  const review = opts.reviewStatus ?? 'none'
  if (review !== 'all') filters.push(eq(posts.reviewStatus, review))
  if (!opts.includeMerged) filters.push(sql`${posts.mergedIntoPostId} is null`)
  if (opts.search) {
    const term = `%${opts.search}%`
    const match = or(ilike(posts.title, term), ilike(posts.body, term))
    if (match) filters.push(match)
  }
  const rows = await db
    .select({ ...adminPostColumns, revenueImpact: revenueImpactSql })
    .from(posts)
    .where(and(...filters))
    .orderBy(...orderFor(opts.sort))

  // Weighted score is computed in app code (small per-project field set) and attached here.
  const weights = await scoreWeights(projectId)
  const scored = rows.map((r) => ({ ...r, score: computeScore(r.fields ?? {}, weights) }))
  if (opts.sort === 'score') scored.sort((a, b) => b.score - a.score)
  return scored
}

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/** Export the (filtered) post list as CSV — votes, revenue, score, and each score field. */
export async function exportPostsCsv(
  ctx: AuthContext,
  projectId: string,
  opts: ListOpts = {},
): Promise<string> {
  const rows = await listPosts(ctx, projectId, { ...opts, sort: opts.sort ?? 'score' })
  const [boardList, statusList, fieldList] = await Promise.all([
    db
      .select({ id: boards.id, name: boards.name })
      .from(boards)
      .where(eq(boards.projectId, projectId)),
    db
      .select({ id: statuses.id, name: statuses.name })
      .from(statuses)
      .where(eq(statuses.projectId, projectId)),
    db
      .select({ key: scoreFields.key, label: scoreFields.label })
      .from(scoreFields)
      .where(eq(scoreFields.projectId, projectId))
      .orderBy(asc(scoreFields.position)),
  ])
  const boardName = new Map(boardList.map((b) => [b.id, b.name]))
  const statusName = new Map(statusList.map((s) => [s.id, s.name]))

  const headers = [
    'Title',
    'Board',
    'Status',
    'Votes',
    'Revenue Impact',
    'Score',
    'App Version',
    'Created',
    ...fieldList.map((f) => f.label),
  ]
  const lines = [headers.map(csvCell).join(',')]
  for (const p of rows) {
    lines.push(
      [
        p.title,
        boardName.get(p.boardId) ?? '',
        p.statusId ? (statusName.get(p.statusId) ?? '') : '',
        p.voteCount,
        p.revenueImpact,
        p.score,
        p.appVersion ?? '',
        p.createdAt,
        ...fieldList.map((f) => p.fields?.[f.key] ?? ''),
      ]
        .map(csvCell)
        .join(','),
    )
  }
  return `${lines.join('\n')}\n`
}

/** Semantic search by a query embedding (pgvector cosine). Returns posts + similarity. */
export async function semanticSearch(
  ctx: AuthContext,
  projectId: string,
  embedding: number[],
  limit = 10,
) {
  await getProject(ctx, projectId)
  const literal = `[${embedding.join(',')}]`
  const rows = await db.execute<{
    id: string
    title: string
    body: string
    vote_count: number
    similarity: number
  }>(sql`
    select id, title, body, vote_count, 1 - (embedding <=> ${literal}::vector) as similarity
    from posts
    where project_id = ${projectId} and merged_into_post_id is null and embedding is not null
    order by embedding <=> ${literal}::vector
    limit ${limit}`)
  return Array.from(rows).map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    voteCount: r.vote_count,
    similarity: Number(r.similarity),
  }))
}

export async function getPost(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select(adminPostColumns)
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.projectId, projectId)))
  if (!row) throw notFound('Post')
  const score = computeScore(row.fields ?? {}, await scoreWeights(projectId))
  return { ...row, score }
}

/**
 * The free-form submission context map (userAgent, locale, platform, screen, plan, …) a
 * widget can attach to a post. Admin-only — never serialized on the public feed because it
 * can carry end-user detail. `appVersion` is promoted to a first-class column separately.
 */
export async function getContext(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select({ appVersion: posts.appVersion, context: posts.context })
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.projectId, projectId)))
  if (!row) throw notFound('Post')
  return { appVersion: row.appVersion, context: (row.context ?? {}) as Record<string, unknown> }
}

/**
 * The post author's end-user + their company (Phase 11). Powers the "Customer" card on the
 * admin post detail — who asked, and what account/MRR they represent. Admin-only.
 */
export async function getPostCustomer(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [post] = await db
    .select({ authorEndUserId: posts.authorEndUserId })
    .from(posts)
    .where(and(eq(posts.id, id), eq(posts.projectId, projectId)))
  if (!post) throw notFound('Post')
  if (!post.authorEndUserId) return { endUser: null, company: null }

  const [eu] = await db
    .select({
      id: endUsers.id,
      name: endUsers.name,
      email: endUsers.email,
      isAnonymous: endUsers.isAnonymous,
      companyId: endUsers.companyId,
    })
    .from(endUsers)
    .where(eq(endUsers.id, post.authorEndUserId))
  if (!eu) return { endUser: null, company: null }

  const company = eu.companyId
    ? ((await db.select().from(companies).where(eq(companies.id, eu.companyId)))[0] ?? null)
    : null
  return { endUser: eu, company }
}

async function assertBoardInProject(projectId: string, boardId: string) {
  const [b] = await db
    .select({ id: boards.id })
    .from(boards)
    .where(and(eq(boards.id, boardId), eq(boards.projectId, projectId)))
  if (!b) throw badRequest('Board does not belong to this project')
}

export async function createPost(ctx: AuthContext, projectId: string, input: AdminCreatePostInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  await assertBoardInProject(projectId, input.boardId)
  if (input.statusId) await assertStatusInProject(projectId, input.statusId)
  const id = newId('post')
  const sent = analyzeSentiment(`${input.title}\n${input.body}`)
  await db.insert(posts).values({
    id,
    projectId,
    boardId: input.boardId,
    title: input.title,
    body: input.body,
    statusId: input.statusId,
    originalLocale: input.locale ?? 'en',
    authorMemberId: ctx.memberId,
    sentiment: sent.score,
    sentimentLabel: sent.label,
  })
  await enqueuePostProcessing(id)
  await enqueueWebhookEvent(projectId, 'post.created', { postId: id, boardId: input.boardId })
  await enqueueGithubAutoCreate(projectId, id)
  return getPost(ctx, projectId, id)
}

/**
 * Create an AI-ingested post in the `pending` review state (Autopilot, Phase 14). It is hidden
 * from the public board and the default admin list until a human approves it. Lands on the
 * first feature board (or any board) and gets embedded/de-duped like a normal post.
 */
export async function createReviewPost(
  ctx: AuthContext,
  projectId: string,
  input: { title: string; body: string; source: Record<string, unknown> },
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const projectBoards = await db
    .select({ id: boards.id, kind: boards.kind })
    .from(boards)
    .where(eq(boards.projectId, projectId))
    .orderBy(asc(boards.position))
  const board = projectBoards.find((b) => b.kind === 'feature') ?? projectBoards[0]
  if (!board) throw badRequest('Project has no board to ingest into')

  const id = newId('post')
  const title = input.title.slice(0, 300) || 'Untitled feedback'
  const sent = analyzeSentiment(`${title}\n${input.body}`)
  await db.insert(posts).values({
    id,
    projectId,
    boardId: board.id,
    title,
    body: input.body,
    reviewStatus: 'pending',
    source: input.source,
    sentiment: sent.score,
    sentimentLabel: sent.label,
  })
  await autoTagPost(projectId, id, `${title}\n${input.body}`)
  await enqueuePostProcessing(id) // embed + dedup so review shows duplicate suggestions
  return getPost(ctx, projectId, id)
}

/** Approve a pending AI-ingested post → it goes live (and fires the normal created hooks). */
export async function approvePost(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  const post = await getPost(ctx, projectId, id)
  if (post.reviewStatus !== 'pending') return post
  await db.update(posts).set({ reviewStatus: 'none' }).where(eq(posts.id, id))
  await enqueueWebhookEvent(projectId, 'post.created', { postId: id, boardId: post.boardId })
  return getPost(ctx, projectId, id)
}

/** Dismiss a pending AI-ingested post → hidden from the review queue, never published. */
export async function dismissPost(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getPost(ctx, projectId, id)
  await db.update(posts).set({ reviewStatus: 'dismissed' }).where(eq(posts.id, id))
  return { id, dismissed: true }
}

export async function updatePost(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdatePostInput,
) {
  assertPermission(ctx, 'write')
  await getPost(ctx, projectId, id)
  if (input.boardId) await assertBoardInProject(projectId, input.boardId)
  if (input.statusId) await assertStatusInProject(projectId, input.statusId)
  if (input.assigneeMemberId) {
    const [assignee] = await db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, input.assigneeMemberId), eq(members.orgId, ctx.orgId)))
    if (!assignee) throw notFound('Member')
  }
  await db
    .update(posts)
    .set({
      title: input.title,
      body: input.body,
      statusId: input.statusId,
      boardId: input.boardId,
      isPinned: input.isPinned,
      eta: input.eta ? new Date(input.eta) : input.eta === null ? null : undefined,
      assigneeMemberId: input.assigneeMemberId === undefined ? undefined : input.assigneeMemberId,
      fields: input.fields,
    })
    .where(eq(posts.id, id))
  return getPost(ctx, projectId, id)
}

async function assertStatusInProject(projectId: string, statusId: string) {
  const [status] = await db
    .select({ id: statuses.id })
    .from(statuses)
    .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)))
  if (!status) throw notFound('Status')
}

export async function changeStatus(
  ctx: AuthContext,
  projectId: string,
  id: string,
  statusId: string | null,
) {
  assertPermission(ctx, 'write')
  await getPost(ctx, projectId, id)
  let statusKind: string | null = null
  if (statusId) {
    const [s] = await db
      .select({ id: statuses.id, kind: statuses.kind })
      .from(statuses)
      .where(and(eq(statuses.id, statusId), eq(statuses.projectId, projectId)))
    if (!s) throw badRequest('Status does not belong to this project')
    statusKind = s.kind
  }
  await db.update(posts).set({ statusId }).where(eq(posts.id, id))
  await enqueueWebhookEvent(projectId, 'post.status_changed', { postId: id, statusId })
  if (statusKind) await enqueueIntegrationSync(projectId, id, statusKind)
  await enqueueNotification('status-changed', { projectId, postId: id })
  await recordAudit(ctx, 'post.status_changed', id, { projectId, statusId })
  return getPost(ctx, projectId, id)
}

export async function setPinned(ctx: AuthContext, projectId: string, id: string, pinned: boolean) {
  assertPermission(ctx, 'write')
  await getPost(ctx, projectId, id)
  await db.update(posts).set({ isPinned: pinned }).where(eq(posts.id, id))
  return getPost(ctx, projectId, id)
}

/** Recompute the denormalized vote_count for a post from the votes table. */
async function recountVotes(postId: string) {
  await db
    .update(posts)
    .set({
      voteCount: sql`(select count(*)::int from ${votes} where ${votes.postId} = ${postId})`,
    })
    .where(eq(posts.id, postId))
}

/**
 * Merge `sourceId` into `targetId`: move votes to the canonical post (de-duping voters),
 * mark the source as merged. Admin-confirmed only — never automatic (SPEC §11).
 */
export async function mergePost(
  ctx: AuthContext,
  projectId: string,
  sourceId: string,
  targetId: string,
) {
  assertPermission(ctx, 'write')
  if (sourceId === targetId) throw badRequest('Cannot merge a post into itself')
  const source = await getPost(ctx, projectId, sourceId)
  const target = await getPost(ctx, projectId, targetId)
  if (target.mergedIntoPostId) throw conflict('Target post is itself merged into another post')
  if (source.mergedIntoPostId) throw conflict('Source post is already merged')

  // Move source votes onto target, skipping voters who already voted for target.
  const sourceVotes = await db
    .select({ endUserId: votes.endUserId, weight: votes.weight })
    .from(votes)
    .where(eq(votes.postId, sourceId))
  if (sourceVotes.length > 0) {
    await db
      .insert(votes)
      .values(
        sourceVotes.map((v) => ({ postId: targetId, endUserId: v.endUserId, weight: v.weight })),
      )
      .onConflictDoNothing()
  }

  await db.update(posts).set({ mergedIntoPostId: targetId }).where(eq(posts.id, sourceId))
  await recountVotes(targetId)
  await enqueueWebhookEvent(projectId, 'post.merged', { sourceId, targetId })
  return getPost(ctx, projectId, targetId)
}

export async function deletePost(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getPost(ctx, projectId, id)
  await db.delete(posts).where(eq(posts.id, id))
  return { id, deleted: true }
}

export type DedupSuggestion = { postId: string; title: string; similarity: number }

/** Possible-duplicate suggestions for a post (from the AI dedup task; admin confirms). */
export async function getDedupSuggestions(
  ctx: AuthContext,
  projectId: string,
  postId: string,
): Promise<DedupSuggestion[]> {
  await getProject(ctx, projectId)
  const [job] = await db
    .select({ result: aiJobs.result })
    .from(aiJobs)
    .where(
      and(eq(aiJobs.projectId, projectId), eq(aiJobs.kind, 'dedup'), eq(aiJobs.inputRef, postId)),
    )
    .orderBy(desc(aiJobs.createdAt))
    .limit(1)
  const raw = (job?.result as { suggestions?: DedupSuggestion[] } | null)?.suggestions ?? []
  if (raw.length === 0) return []

  // Keep only suggestions whose target still exists and isn't itself merged away.
  const ids = raw.map((s) => s.postId)
  const live = await db
    .select({ id: posts.id })
    .from(posts)
    .where(and(inArray(posts.id, ids), sql`${posts.mergedIntoPostId} is null`))
  const liveIds = new Set(live.map((p) => p.id))
  return raw.filter((s) => s.postId !== postId && liveIds.has(s.postId))
}
