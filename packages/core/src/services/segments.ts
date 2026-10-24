import { and, asc, db, eq, newId, segments, sql } from '@chorala/db'
import type { CreateSegmentInput, SegmentDefinition, UpdateSegmentInput } from '@chorala/types'
import { segmentDefinition } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { badRequest, notFound } from '../errors.ts'
import { getProject } from './projects.ts'

const OP_SQL: Record<string, string> = {
  eq: '=',
  neq: '<>',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
}

/** Compile one rule to a SQL predicate over the aliases `eu` (end_users) + `c` (companies). */
function ruleSql(r: SegmentDefinition['rules'][number]) {
  const op = sql.raw(OP_SQL[r.op] ?? '=')
  switch (r.field) {
    case 'plan':
      return sql`c.plan ${op} ${r.value}`
    case 'locale':
      return sql`eu.locale ${op} ${r.value}`
    case 'mrr':
      return sql`coalesce(c.mrr, 0) ${op} ${Number.parseInt(r.value, 10) || 0}`
    case 'email_domain':
      return sql`eu.email ilike ${`%@${r.value}`}`
    case 'has_company':
      return sql`(eu.company_id is not null) = ${r.value === 'true'}`
    default:
      return sql`true`
  }
}

/** Build the WHERE predicate for a definition (true when there are no rules → everyone). */
function definitionSql(def: SegmentDefinition) {
  if (def.rules.length === 0) return sql`true`
  const glue = sql.raw(def.match === 'any' ? ' or ' : ' and ')
  return def.rules
    .map(ruleSql)
    .reduce((acc, part, i) => (i === 0 ? part : sql`${acc}${glue}${part}`))
}

export type Recipient = {
  id: string
  email: string | null
  name: string | null
  locale: string
  companyName: string | null
  plan: string | null
}

/** Resolve a definition to matching end-users (left-joined to their company for attributes). */
export async function resolveSegment(
  projectId: string,
  def: SegmentDefinition,
  opts: { withEmailOnly?: boolean } = {},
): Promise<Recipient[]> {
  const where = definitionSql(def)
  const emailFilter = opts.withEmailOnly ? sql` and eu.email is not null` : sql``
  const rows = await db.execute<{
    id: string
    email: string | null
    name: string | null
    locale: string
    company_name: string | null
    plan: string | null
  }>(sql`
    select eu.id, eu.email, eu.name, eu.locale, c.name as company_name, c.plan
    from end_users eu
    left join companies c on eu.company_id = c.id
    where eu.project_id = ${projectId} and (${where})${emailFilter}`)
  return Array.from(rows).map((r) => ({
    id: r.id,
    email: r.email,
    name: r.name,
    locale: r.locale,
    companyName: r.company_name,
    plan: r.plan,
  }))
}

/** Whether a single end-user matches a definition (used for survey targeting). */
export async function isInSegment(
  projectId: string,
  def: SegmentDefinition,
  endUserId: string,
): Promise<boolean> {
  const where = definitionSql(def)
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from end_users eu
    left join companies c on eu.company_id = c.id
    where eu.project_id = ${projectId} and eu.id = ${endUserId} and (${where})`)
  return Number(Array.from(rows)[0]?.n ?? 0) > 0
}

/** How many end-users currently match a definition. */
export async function matchCount(projectId: string, def: SegmentDefinition): Promise<number> {
  const where = definitionSql(def)
  const rows = await db.execute<{ n: number }>(sql`
    select count(*)::int as n from end_users eu
    left join companies c on eu.company_id = c.id
    where eu.project_id = ${projectId} and (${where})`)
  return Number(Array.from(rows)[0]?.n ?? 0)
}

/** Auth'd live count for an unsaved definition (the builder preview). */
export async function previewSegment(ctx: AuthContext, projectId: string, def: SegmentDefinition) {
  await getProject(ctx, projectId)
  return { matchCount: await matchCount(projectId, def) }
}

export async function listSegments(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  const rows = await db
    .select()
    .from(segments)
    .where(eq(segments.projectId, projectId))
    .orderBy(asc(segments.createdAt))
  return Promise.all(
    rows.map(async (s) => ({
      ...s,
      matchCount: await matchCount(projectId, segmentDefinition.parse(s.definition)),
    })),
  )
}

export async function getSegment(ctx: AuthContext, projectId: string, id: string) {
  await getProject(ctx, projectId)
  const [row] = await db
    .select()
    .from(segments)
    .where(and(eq(segments.id, id), eq(segments.projectId, projectId)))
  if (!row) throw notFound('Segment')
  return row
}

export async function createSegment(
  ctx: AuthContext,
  projectId: string,
  input: CreateSegmentInput,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const [row] = await db
    .insert(segments)
    .values({
      id: newId('segment'),
      projectId,
      name: input.name,
      definition: input.definition,
    })
    .returning()
  if (!row) throw badRequest('Failed to create segment')
  return row
}

export async function updateSegment(
  ctx: AuthContext,
  projectId: string,
  id: string,
  input: UpdateSegmentInput,
) {
  assertPermission(ctx, 'write')
  await getSegment(ctx, projectId, id)
  const [row] = await db
    .update(segments)
    .set({ name: input.name, definition: input.definition })
    .where(eq(segments.id, id))
    .returning()
  return row
}

export async function deleteSegment(ctx: AuthContext, projectId: string, id: string) {
  assertPermission(ctx, 'write')
  await getSegment(ctx, projectId, id)
  await db.delete(segments).where(eq(segments.id, id))
  return { id, deleted: true }
}

/** Apply `{{first_name}}`/`{{name}}`/`{{email}}`/`{{company}}`/`{{plan}}` to a string. */
export function renderVars(text: string, r: Recipient): string {
  const first = (r.name ?? '').trim().split(/\s+/)[0] ?? ''
  const vars: Record<string, string> = {
    first_name: first,
    name: r.name ?? '',
    email: r.email ?? '',
    company: r.companyName ?? '',
    plan: r.plan ?? '',
  }
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => vars[k] ?? m)
}
