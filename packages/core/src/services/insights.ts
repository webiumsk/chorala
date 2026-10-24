import { and, companies, db, desc, eq, insights, newId, posts } from '@chorala/db'
import type { CreateInsightInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

async function assertPostInProject(projectId: string, postId: string) {
  const [row] = await db
    .select({ id: posts.id, projectId: posts.projectId })
    .from(posts)
    .where(eq(posts.id, postId))
  if (!row || row.projectId !== projectId) throw badRequest('Post does not belong to this project')
}

/** Attach a customer quote / piece of evidence to a post (feature). */
export async function addInsight(ctx: AuthContext, projectId: string, input: CreateInsightInput) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  await assertPostInProject(projectId, input.postId)
  const id = newId('insight')
  const [row] = await db
    .insert(insights)
    .values({
      id,
      projectId,
      postId: input.postId,
      quote: input.quote,
      source: input.source,
      customerEmail: input.customerEmail,
      companyId: input.companyId,
      createdByMemberId: ctx.memberId,
    })
    .returning()
  return row
}

/** List insights, newest first — optionally scoped to one post. Joins company name + MRR. */
export async function listInsights(
  ctx: AuthContext,
  projectId: string,
  opts: { postId?: string } = {},
) {
  await getProject(ctx, projectId)
  const filters = [eq(insights.projectId, projectId)]
  if (opts.postId) filters.push(eq(insights.postId, opts.postId))
  return db
    .select({
      id: insights.id,
      postId: insights.postId,
      quote: insights.quote,
      source: insights.source,
      customerEmail: insights.customerEmail,
      companyId: insights.companyId,
      companyName: companies.name,
      companyMrr: companies.mrr,
      createdAt: insights.createdAt,
    })
    .from(insights)
    .leftJoin(companies, eq(companies.id, insights.companyId))
    .where(and(...filters))
    .orderBy(desc(insights.createdAt))
}

export async function removeInsight(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [row] = await db.select().from(insights).where(eq(insights.id, id))
  if (!row || row.projectId !== projectId) throw notFound('Insight')
  await db.delete(insights).where(eq(insights.id, id))
  return { id, deleted: true }
}
