import { env } from '@chorala/config'
import { AppError, projects, unauthorized } from '@chorala/core'
import type { Context, MiddlewareHandler } from 'hono'
import { redis } from '../lib/redis.ts'
import type { PublicEnv, PublicProject } from '../types.ts'

const RATE_WINDOW_SEC = 60

function clientIp(c: Context): string {
  const fwd = c.req.header('x-forwarded-for')
  if (fwd) return fwd.split(',')[0]?.trim() || 'unknown'
  return c.req.header('x-real-ip') || 'local'
}

async function enforceRateLimit(c: Context, projectId: string) {
  const limit = env.CHORALA_RATE_LIMIT_PUBLIC
  const window = Math.floor(Date.now() / 1000 / RATE_WINDOW_SEC)
  const key = `rl:${projectId}:${clientIp(c)}:${window}`
  try {
    const count = await redis.incr(key)
    if (count === 1) await redis.expire(key, RATE_WINDOW_SEC)
    c.header('X-RateLimit-Limit', String(limit))
    c.header('X-RateLimit-Remaining', String(Math.max(0, limit - count)))
    if (count > limit) throw new AppError('rate_limited', 'Rate limit exceeded', 429)
  } catch (err) {
    if (err instanceof AppError) throw err
    // Reads can degrade; expensive writes must not become unlimited during an outage.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
      throw new AppError('service_unavailable', 'Public writes are temporarily unavailable', 503)
    }
    console.warn('[api] read rate-limit check unavailable')
  }
}

// The hosted portal (chorala.com/portal/…) and a project's own custom domain are first-party
// surfaces — votes/comments/surveys must work from them without the customer hand-whitelisting
// Chorala's own hostnames in allowed_origins. Derive the Chorala origin once at module load.
const CHORALA_ORIGIN = new URL(env.CHORALA_PUBLIC_URL).origin

function applyCors(c: Context, project: PublicProject): boolean {
  const origin = c.req.header('origin')
  if (!origin) return true // non-browser client (server-to-server / curl)
  const allowed =
    project.allowedOrigins.includes('*') ||
    project.allowedOrigins.includes(origin) ||
    origin === CHORALA_ORIGIN ||
    (project.customDomain != null && origin === `https://${project.customDomain}`)
  if (!allowed) return false
  setCorsHeaders(c, origin)
  return true
}

function setCorsHeaders(c: Context, origin: string) {
  c.header('Access-Control-Allow-Origin', origin)
  c.header('Access-Control-Allow-Credentials', 'true')
  c.header('Vary', 'Origin')
  c.header('Access-Control-Allow-Headers', 'content-type, x-chorala-key, x-chorala-user')
  c.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
  c.header('Access-Control-Max-Age', '600')
}

/** Resolves the project from `X-Chorala-Key`, enforces per-project CORS + Redis rate limiting. */
export const publicProject: MiddlewareHandler<PublicEnv> = async (c, next) => {
  // CORS preflight: the browser never sends X-Chorala-Key on OPTIONS, so answer it before
  // requiring the key. Permissively echo the origin; the real request still enforces
  // the project's allowed_origins (below) — a disallowed origin gets a 403 with no ACAO.
  if (c.req.method === 'OPTIONS') {
    const origin = c.req.header('origin')
    if (origin) setCorsHeaders(c, origin)
    return c.body(null, 204)
  }

  const key = c.req.header('x-chorala-key')
  if (!key) throw unauthorized('Missing X-Chorala-Key')
  const project = await projects.getByPublicKey(key)
  if (!project) throw unauthorized('Invalid project key')

  if (!applyCors(c, project)) {
    throw new AppError('cors_forbidden', 'Origin not allowed for this project', 403)
  }

  await enforceRateLimit(c, project.id)
  c.set('project', project)
  return next()
}
