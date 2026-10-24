import { env } from '@chorala/config'
import { type AuthContext, apiKeys, assertPermission, forbidden, unauthorized } from '@chorala/core'
import { db, eq, members, projects } from '@chorala/db'
import type { MiddlewareHandler } from 'hono'
import { auth } from '../auth.ts'
import type { AppEnv } from '../types.ts'

/** Resolves a Better Auth session cookie OR an `Authorization: Bearer hk_...` API key
 *  into an AuthContext, scoped to the caller's org (and project, for api keys). */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const authz = c.req.header('authorization')

  // --- API key path ---
  if (authz?.startsWith('Bearer hk_')) {
    const resolved = await apiKeys.resolveApiKey(authz.slice('Bearer '.length))
    if (!resolved) throw unauthorized('Invalid API key')
    const [proj] = await db
      .select({ orgId: projects.orgId })
      .from(projects)
      .where(eq(projects.id, resolved.projectId))
    if (!proj) throw unauthorized('Invalid API key')
    c.set('auth', {
      kind: 'apikey',
      orgId: proj.orgId,
      projectId: resolved.projectId,
      scopes: resolved.scopes,
    } satisfies AuthContext)
    return next()
  }

  // --- Session cookie path ---
  const session = await auth.api.getSession({ headers: c.req.raw.headers })
  if (!session?.user) throw unauthorized()
  if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
    // CORS controls response access, not whether a cookie-authenticated write runs.
    const trustedOrigins = [env.CHORALA_PUBLIC_URL, env.CHORALA_API_URL].map(
      (url) => new URL(url).origin,
    )
    if (!trustedOrigins.includes(c.req.header('origin') ?? '')) {
      throw forbidden('Invalid request origin')
    }
  }

  const orgHeader = c.req.header('x-chorala-org')
  const rows = await db.select().from(members).where(eq(members.userId, session.user.id))
  const membership = orgHeader ? rows.find((m) => m.orgId === orgHeader) : rows[0]
  if (!membership) throw unauthorized('User is not a member of any organization')

  c.set('auth', {
    kind: 'session',
    orgId: membership.orgId,
    userId: session.user.id,
    memberId: membership.id,
    role: membership.role,
  } satisfies AuthContext)
  return next()
}

/** Enforce transport permissions before any route can cause a side effect. */
export const requirePermission: MiddlewareHandler<AppEnv> = async (c, next) => {
  const ctx = c.get('auth')
  if (ctx.kind === 'apikey' && /^\/api\/v1\/org(?:\/|$)/.test(c.req.path)) {
    throw forbidden('Project API keys cannot access organization-wide endpoints')
  }
  const safe = ['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)
  // These POST endpoints compute a read-only result; they do not persist a mutation.
  const readQuery =
    c.req.method === 'POST' &&
    /^\/api\/v1\/projects\/[^/]+\/(?:ask|segments\/preview|changelog\/draft|posts\/[^/]+\/(?:summarize|draft-reply))$/.test(
      c.req.path,
    )
  const ownNotifications =
    c.req.method === 'POST' && c.req.path === '/api/v1/org/notifications/read'
  const moderation = /^\/api\/v1\/projects\/[^/]+\/moderation(?:\/|$)/.test(c.req.path)
  assertPermission(
    ctx,
    safe || ownNotifications || readQuery ? 'read' : moderation ? 'moderate' : 'write',
  )
  return next()
}
