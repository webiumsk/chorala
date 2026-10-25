import { DEFAULT_STATUSES } from '@chorala/config'
import {
  and,
  boards,
  db,
  eq,
  generatePublicKey,
  generateSecret,
  newId,
  projects,
  statuses,
} from '@chorala/db'
import type { CreateProjectInput, UpdateProjectInput } from '@chorala/types'
import { type AuthContext, assertPermission, canManageOrg } from '../context.ts'
import { badRequest, conflict, forbidden, notFound } from '../errors.ts'
import { recordAudit } from './audit.ts'

export async function listProjects(ctx: AuthContext) {
  assertPermission(ctx, 'read')
  // An api-key caller only ever sees the single project it is scoped to.
  if (ctx.kind === 'apikey' && ctx.projectId) {
    const rows = await db
      .select()
      .from(projects)
      .where(and(eq(projects.orgId, ctx.orgId), eq(projects.id, ctx.projectId)))
    return rows.map((row) => ({ ...row, endUserJwtSecret: undefined }))
  }
  const rows = await db.select().from(projects).where(eq(projects.orgId, ctx.orgId))
  return rows.map((row) => ({
    ...row,
    endUserJwtSecret: canManageOrg(ctx) ? row.endUserJwtSecret : undefined,
  }))
}

export async function getProject(ctx: AuthContext, id: string) {
  // Api keys are project-scoped: deny access to any other project in the org.
  if (ctx.kind === 'apikey' && ctx.projectId && ctx.projectId !== id) throw notFound('Project')
  const [row] = await db
    .select()
    .from(projects)
    .where(and(eq(projects.id, id), eq(projects.orgId, ctx.orgId)))
  if (!row) throw notFound('Project')
  return { ...row, endUserJwtSecret: canManageOrg(ctx) ? row.endUserJwtSecret : undefined }
}

export async function createProject(ctx: AuthContext, input: CreateProjectInput) {
  if (!canManageOrg(ctx)) throw forbidden('Only org admins can create projects')

  const [existing] = await db
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.orgId, ctx.orgId), eq(projects.slug, input.slug)))
  if (existing) throw conflict(`A project with slug "${input.slug}" already exists`)

  const id = newId('project')
  const [project] = await db
    .insert(projects)
    .values({
      id,
      orgId: ctx.orgId,
      slug: input.slug,
      name: input.name,
      isPublic: input.isPublic,
      allowedOrigins: input.allowedOrigins,
      publicKey: generatePublicKey(),
      endUserJwtSecret: generateSecret(),
    })
    .returning()
  if (!project) throw badRequest('Failed to create project')

  // Seed default statuses + starter boards so the project is immediately usable.
  await db.insert(statuses).values(
    DEFAULT_STATUSES.map((s) => ({
      projectId: id,
      name: s.name,
      color: s.color,
      kind: s.kind,
      position: s.position,
      showOnRoadmap: s.showOnRoadmap,
    })),
  )
  await db.insert(boards).values([
    {
      projectId: id,
      slug: 'feature-requests',
      name: 'Feature Requests',
      kind: 'feature',
      position: 0,
    },
    { projectId: id, slug: 'bugs', name: 'Bugs', kind: 'bug', position: 1 },
  ])

  await recordAudit(ctx, 'project.created', id, { slug: input.slug, name: input.name })
  return project
}

export async function updateProject(ctx: AuthContext, id: string, input: UpdateProjectInput) {
  if (!canManageOrg(ctx)) throw forbidden('Only org admins can update projects')
  await getProject(ctx, id) // scope check

  const [row] = await db
    .update(projects)
    .set({
      name: input.name,
      slug: input.slug,
      isPublic: input.isPublic,
      allowedOrigins: input.allowedOrigins,
      customDomain: input.customDomain ?? undefined,
      widgetSettings: input.widgetSettings,
    })
    .where(eq(projects.id, id))
    .returning()
  await recordAudit(ctx, 'project.updated', id, {})
  return row
}

export async function deleteProject(ctx: AuthContext, id: string) {
  if (!canManageOrg(ctx)) throw forbidden('Only org admins can delete projects')
  await getProject(ctx, id)
  await db.delete(projects).where(eq(projects.id, id))
  await recordAudit(ctx, 'project.deleted', id, {})
  return { id, deleted: true }
}

/** Resolve a project the api-key caller is scoped to (api-key auth path). */
export async function getScopedProject(ctx: AuthContext) {
  if (!ctx.projectId) throw forbidden('This endpoint requires a project-scoped key')
  return getProject(ctx, ctx.projectId)
}

/** Resolve a project by its public (`pk_...`) key — the public/widget API entry point. */
export async function getByPublicKey(publicKey: string) {
  const [row] = await db.select().from(projects).where(eq(projects.publicKey, publicKey))
  return row ?? null
}
