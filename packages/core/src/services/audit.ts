import { and, auditLog, db, desc, eq, lte, newId, users } from '@chorala/db'
import { type AuthContext, canManageOrg } from '../context.ts'
import { forbidden } from '../errors.ts'

/** A stable string for "who did this" — the session user id, or the API key's project scope. */
function actorOf(ctx: AuthContext): string {
  if (ctx.kind === 'session') return ctx.userId ?? ctx.memberId ?? 'session'
  return ctx.projectId ? `apikey:${ctx.projectId}` : 'apikey'
}

/**
 * Append an entry to the org's audit log. Best-effort: a logging failure must never break the
 * mutation it records, so we swallow errors (and warn) rather than throw. Call AFTER the
 * change succeeds, passing the same `ctx` that authorized it.
 */
export async function recordAudit(
  ctx: AuthContext,
  action: string,
  target: string,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  try {
    await db.insert(auditLog).values({
      id: newId('auditLog'),
      orgId: ctx.orgId,
      actor: actorOf(ctx),
      action,
      target,
      metadata,
    })
  } catch (err) {
    console.warn('[audit] failed to record', action, target, (err as Error).message)
  }
}

export type AuditListOpts = { action?: string; limit?: number; before?: string }

/**
 * Read the org's audit trail, newest first, resolving the actor to a name/email when it's a
 * known user. Sensitive governance data - restricted to org admins. Project-scoped API keys
 * cannot expose other projects' audit events.
 */
export async function listAuditLog(ctx: AuthContext, opts: AuditListOpts = {}) {
  if (!canManageOrg(ctx)) {
    throw forbidden('Only org admins can read the audit log')
  }
  const filters = [eq(auditLog.orgId, ctx.orgId)]
  if (opts.action) filters.push(eq(auditLog.action, opts.action))
  if (opts.before) filters.push(lte(auditLog.createdAt, new Date(opts.before)))

  const rows = await db
    .select({
      id: auditLog.id,
      actor: auditLog.actor,
      actorName: users.name,
      actorEmail: users.email,
      action: auditLog.action,
      target: auditLog.target,
      metadata: auditLog.metadata,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actor))
    .where(and(...filters))
    .orderBy(desc(auditLog.createdAt))
    .limit(Math.min(opts.limit ?? 100, 200))
  return rows
}
