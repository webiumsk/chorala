import { and, companies, db, eq, newId, sql } from '@chorala/db'
import type { UpdateCompanyInput } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

export type CompanyIdentity = {
  externalId: string
  name?: string
  domain?: string
  mrr?: number
  plan?: string
}

/**
 * Upsert a company from an identify payload, keyed by (project, externalId). Only overwrites
 * fields the host actually sent, so a later token without `mrr` doesn't wipe an edited value.
 * Returns the company id (to stamp on the end-user). Internal — no auth context.
 */
export async function upsertFromIdentity(
  projectId: string,
  identity: CompanyIdentity,
): Promise<string> {
  const [existing] = await db
    .select({ id: companies.id })
    .from(companies)
    .where(and(eq(companies.projectId, projectId), eq(companies.externalId, identity.externalId)))

  if (existing) {
    await db
      .update(companies)
      .set({
        name: identity.name ?? undefined,
        domain: identity.domain ?? undefined,
        mrr: identity.mrr ?? undefined,
        plan: identity.plan ?? undefined,
      })
      .where(eq(companies.id, existing.id))
    return existing.id
  }

  const id = newId('company')
  await db.insert(companies).values({
    id,
    projectId,
    externalId: identity.externalId,
    name: identity.name ?? identity.externalId,
    domain: identity.domain,
    mrr: identity.mrr ?? 0,
    plan: identity.plan,
  })
  return id
}

/** Companies for a project with rollups (user + post counts), richest accounts first. */
export async function listCompanies(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  // `"companies"."id"` is a literal (not ${companies.id}): the correlated outer column must stay
  // qualified inside these SELECT-list subqueries, else it renders unqualified and collides with
  // the inner tables' `id` columns ("column reference id is ambiguous").
  const userCount = sql<number>`(
    select count(*)::int from end_users where end_users.company_id = "companies"."id"
  )`
  const postCount = sql<number>`(
    select count(*)::int from posts
    join end_users on posts.author_end_user_id = end_users.id
    where end_users.company_id = "companies"."id"
  )`
  return db
    .select({
      id: companies.id,
      projectId: companies.projectId,
      externalId: companies.externalId,
      name: companies.name,
      domain: companies.domain,
      mrr: companies.mrr,
      plan: companies.plan,
      metadata: companies.metadata,
      createdAt: companies.createdAt,
      updatedAt: companies.updatedAt,
      userCount,
      postCount,
    })
    .from(companies)
    .where(eq(companies.projectId, projectId))
    .orderBy(sql`${companies.mrr} desc`, companies.name)
}

export async function getCompany(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select()
    .from(companies)
    .where(and(eq(companies.id, id), eq(companies.projectId, projectId)))
  if (!row) throw notFound('Company')
  return row
}

/** Edit an account's MRR / plan / name (e.g. when revenue isn't synced from the JWT). */
export async function updateCompany(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateCompanyInput,
) {
  assertPermission(ctx, 'write')
  await getCompany(ctx, projectId, id)
  if (
    input.name === undefined &&
    input.mrr === undefined &&
    input.plan === undefined &&
    input.domain === undefined
  ) {
    throw badRequest('No fields to update')
  }
  await db
    .update(companies)
    .set({
      name: input.name,
      domain: input.domain === undefined ? undefined : input.domain,
      mrr: input.mrr,
      plan: input.plan === undefined ? undefined : input.plan,
    })
    .where(eq(companies.id, id))
  return getCompany(ctx, projectId, id)
}
