import { env } from '@chorala/config'
import {
  and,
  boards,
  db,
  endUsers,
  eq,
  generateSecret,
  integrations,
  newId,
  posts,
} from '@chorala/db'
import type { InboundEvent } from '@chorala/types'
import { type AuthContext, assertPermission } from '../context.ts'
import { decryptSecret, encryptSecret } from '../crypto.ts'
import { badRequest, notFound } from '../errors.ts'
import { upsertFromIdentity as upsertCompany } from './companies.ts'
import { upsertFromIdentity as upsertEndUser } from './endUsers.ts'
import { getProject } from './projects.ts'

const GH = 'https://api.github.com'
const ghHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'content-type': 'application/json',
  'user-agent': 'chorala',
})

export type GithubAutoCreate = 'off' | 'bug' | 'all'
type GithubConfig = { repo: string; autoCreate?: GithubAutoCreate }
type IssueLink = { number: number; url: string }

/** List a project's integrations (never returns secrets). */
export async function listIntegrations(ctx: AuthContext, projectId: string) {
  await getProject(ctx, projectId)
  return db
    .select({ id: integrations.id, type: integrations.type, config: integrations.config })
    .from(integrations)
    .where(eq(integrations.projectId, projectId))
}

/** Connect (or update) a GitHub repo for a project; the token is encrypted at rest. */
export async function setGithubIntegration(
  ctx: AuthContext,
  projectId: string,
  input: { repo: string; token?: string; autoCreate?: GithubAutoCreate },
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  if (!/^[\w.-]+\/[\w.-]+$/.test(input.repo)) {
    throw badRequest('Repository must be in "owner/name" form')
  }
  const [existing] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'github')))
  const secret = input.token ? encryptSecret(input.token) : existing?.secret
  if (!secret) throw badRequest('A GitHub token is required to connect')
  const config: GithubConfig = {
    repo: input.repo,
    autoCreate:
      input.autoCreate ?? (existing?.config as GithubConfig | undefined)?.autoCreate ?? 'off',
  }
  if (existing) {
    await db.update(integrations).set({ config, secret }).where(eq(integrations.id, existing.id))
  } else {
    await db
      .insert(integrations)
      .values({ id: newId('integration'), projectId, type: 'github', config, secret })
  }
  return { repo: input.repo, connected: true }
}

export async function removeGithubIntegration(ctx: AuthContext, projectId: string) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  await db
    .delete(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'github')))
}

/** The GitHub issue linked to a post (admin view), or null. */
export async function getPostIssue(
  ctx: AuthContext,
  projectId: string,
  postId: string,
): Promise<IssueLink | null> {
  await getProject(ctx, projectId)
  const [post] = await db
    .select({ metadata: posts.metadata })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.projectId, projectId)))
  return (post?.metadata as { githubIssue?: IssueLink } | undefined)?.githubIssue ?? null
}

async function resolveGithub(
  projectId: string,
): Promise<{ repo: string; token: string; autoCreate: GithubAutoCreate } | null> {
  const [row] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'github')))
  if (!row?.secret) return null
  const cfg = row.config as GithubConfig
  return { repo: cfg.repo, token: decryptSecret(row.secret), autoCreate: cfg.autoCreate ?? 'off' }
}

type IssuePost = {
  title: string
  body: string
  voteCount: number
  metadata: unknown
}

/** POST the issue to GitHub and link it on the post. Shared by manual + auto-create. */
async function postIssue(
  gh: { repo: string; token: string },
  postId: string,
  post: IssuePost,
): Promise<IssueLink> {
  const res = await fetch(`${GH}/repos/${gh.repo}/issues`, {
    method: 'POST',
    headers: ghHeaders(gh.token),
    body: JSON.stringify({
      title: post.title,
      body: `${post.body || '_No description._'}\n\n— ${post.voteCount} vote(s) on Chorala`,
      labels: ['chorala'],
    }),
  })
  if (!res.ok) throw badRequest(`GitHub error ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const issue = (await res.json()) as { number: number; html_url: string }
  const link: IssueLink = { number: issue.number, url: issue.html_url }
  await db
    .update(posts)
    .set({ metadata: { ...(post.metadata as object), githubIssue: link } })
    .where(eq(posts.id, postId))
  return link
}

/** Create a GitHub issue from a post and link it on the post (idempotent). Manual, admin-only. */
export async function createGithubIssue(
  ctx: AuthContext,
  projectId: string,
  postId: string,
): Promise<IssueLink> {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const gh = await resolveGithub(projectId)
  if (!gh) throw badRequest('GitHub is not connected for this project')
  const [post] = await db
    .select({
      title: posts.title,
      body: posts.body,
      voteCount: posts.voteCount,
      metadata: posts.metadata,
    })
    .from(posts)
    .where(and(eq(posts.id, postId), eq(posts.projectId, projectId)))
  if (!post) throw notFound('Post')
  const existing = (post.metadata as { githubIssue?: IssueLink }).githubIssue
  if (existing?.url) return existing
  return postIssue(gh, postId, post)
}

/** Auto-create an issue for a new post if the integration is configured to (system path). */
export async function autoCreateIssue(projectId: string, postId: string) {
  const gh = await resolveGithub(projectId)
  if (!gh || gh.autoCreate === 'off') return
  const [post] = await db
    .select({
      title: posts.title,
      body: posts.body,
      voteCount: posts.voteCount,
      metadata: posts.metadata,
      boardKind: boards.kind,
    })
    .from(posts)
    .innerJoin(boards, eq(boards.id, posts.boardId))
    .where(and(eq(posts.id, postId), eq(posts.projectId, projectId)))
  if (!post) return
  if (gh.autoCreate === 'bug' && post.boardKind !== 'bug') return
  if ((post.metadata as { githubIssue?: IssueLink }).githubIssue?.url) return
  await postIssue(gh, postId, post)
}

/** Sync a linked issue on status change: comment + close/reopen. Called by the worker. */
export async function syncGithubIssue(projectId: string, postId: string, statusKind: string) {
  const gh = await resolveGithub(projectId)
  if (!gh) return
  const [post] = await db
    .select({ metadata: posts.metadata })
    .from(posts)
    .where(eq(posts.id, postId))
  const link = (post?.metadata as { githubIssue?: IssueLink } | undefined)?.githubIssue
  if (!link?.number) return

  await fetch(`${GH}/repos/${gh.repo}/issues/${link.number}/comments`, {
    method: 'POST',
    headers: ghHeaders(gh.token),
    body: JSON.stringify({
      body: `Status on Chorala changed to **${statusKind.replace('_', ' ')}**.`,
    }),
  })
  const state = statusKind === 'complete' || statusKind === 'closed' ? 'closed' : 'open'
  await fetch(`${GH}/repos/${gh.repo}/issues/${link.number}`, {
    method: 'PATCH',
    headers: ghHeaders(gh.token),
    body: JSON.stringify({ state }),
  })
}

// =====================================================================
// Discord (outbound notifications) — Phase 15
// =====================================================================

/** Connect a Discord incoming-webhook URL (encrypted at rest). */
export async function setDiscordIntegration(
  ctx: AuthContext,
  projectId: string,
  webhookUrl: string,
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  if (!/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(webhookUrl)) {
    throw badRequest('Expected a https://discord.com/api/webhooks/… URL')
  }
  const secret = encryptSecret(webhookUrl)
  const [existing] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'discord')))
  if (existing) {
    await db.update(integrations).set({ secret }).where(eq(integrations.id, existing.id))
  } else {
    await db
      .insert(integrations)
      .values({ id: newId('integration'), projectId, type: 'discord', config: {}, secret })
  }
  return { connected: true }
}

/** Post a plain message to the project's Discord channel (no-op if not connected). */
export async function notifyDiscord(projectId: string, content: string) {
  const [row] = await db
    .select({ secret: integrations.secret })
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'discord')))
  if (!row?.secret) return
  try {
    await fetch(decryptSecret(row.secret), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ content: content.slice(0, 1900) }),
    })
  } catch (err) {
    console.warn('[integrations] discord notify failed:', (err as Error).message)
  }
}

// =====================================================================
// Segment-compatible inbound webhook — Phase 15
// =====================================================================

/** Enable the inbound webhook; returns the signing secret (shown once) + the URL to configure. */
export async function setSegmentIntegration(ctx: AuthContext, projectId: string) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  const raw = generateSecret(24)
  const secret = encryptSecret(raw)
  const [existing] = await db
    .select()
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'segment')))
  if (existing) {
    await db.update(integrations).set({ secret }).where(eq(integrations.id, existing.id))
  } else {
    await db
      .insert(integrations)
      .values({ id: newId('integration'), projectId, type: 'segment', config: {}, secret })
  }
  return {
    secret: raw,
    url: `${env.CHORALA_API_URL}/api/v1/inbound/${projectId}`,
  }
}

/** Validate an inbound webhook bearer token against the stored segment secret. */
export async function verifyInboundSecret(projectId: string, token: string): Promise<boolean> {
  const [row] = await db
    .select({ secret: integrations.secret })
    .from(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, 'segment')))
  if (!row?.secret) return false
  return decryptSecret(row.secret) === token
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) =>
  typeof v === 'number' ? v : typeof v === 'string' && v.trim() ? Number.parseInt(v, 10) : undefined

/**
 * Apply a Segment-compatible event: `identify` upserts an end-user (traits → segment), `group`
 * upserts a company (name/plan/mrr/domain) and links the user to it. Other event types are ignored.
 */
export async function processInbound(projectId: string, event: InboundEvent) {
  const t = event.traits ?? {}
  if (event.type === 'identify' && event.userId) {
    await upsertEndUser(projectId, {
      id: event.userId,
      email: str(t.email),
      name: str(t.name),
      avatar: str(t.avatar),
      segment: t,
    })
    return { processed: 'identify' as const }
  }
  if (event.type === 'group' && event.groupId) {
    const companyId = await upsertCompany(projectId, {
      externalId: event.groupId,
      name: str(t.name),
      domain: str(t.domain) ?? str(t.website),
      plan: str(t.plan),
      mrr: num(t.mrr),
    })
    if (event.userId) {
      await db
        .update(endUsers)
        .set({ companyId })
        .where(and(eq(endUsers.projectId, projectId), eq(endUsers.externalId, event.userId)))
    }
    return { processed: 'group' as const }
  }
  return { processed: 'ignored' as const }
}

/** Generic disconnect by type (Discord / Segment). */
export async function removeIntegration(
  ctx: AuthContext,
  projectId: string,
  type: 'discord' | 'segment',
) {
  assertPermission(ctx, 'write')
  await getProject(ctx, projectId)
  await db
    .delete(integrations)
    .where(and(eq(integrations.projectId, projectId), eq(integrations.type, type)))
  return { removed: true }
}
