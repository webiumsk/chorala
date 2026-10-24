import { randomUUID } from 'node:crypto'
import { env } from '@chorala/config'
import { type AuthContext, projects as projectService } from '@chorala/core'
import { and, client, db, eq, members, posts, projects, users } from '@chorala/db'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { verifyEndUserJwt } from '../src/lib/jwt.ts'
import { redis } from '../src/lib/redis.ts'

const secret = 'synthetic-project-signing-secret-at-least-32-bytes'
const key = new TextEncoder().encode(secret)
const app = createApp()
let a: Awaited<ReturnType<typeof projectService.createProject>>
let b: typeof a

beforeAll(async () => {
  const [member] = await db.select().from(members).where(eq(members.role, 'owner')).limit(1)
  if (!member) throw new Error('Synthetic seed owner missing')
  const ctx: AuthContext = {
    kind: 'session',
    orgId: member.orgId,
    userId: member.userId,
    memberId: member.id,
    role: 'owner',
  }
  const input = () => ({
    name: 'Identity regression',
    slug: randomUUID(),
    isPublic: true,
    allowedOrigins: [],
  })
  a = await projectService.createProject(ctx, input())
  b = await projectService.createProject(ctx, input())
})

afterAll(async () => {
  if (a) await db.delete(projects).where(eq(projects.id, a.id))
  if (b) await db.delete(projects).where(eq(projects.id, b.id))
  await redis.quit()
  await client.end()
})

describe('bounded project-signed identities', () => {
  test('accepts the existing one-hour Satflux claims without requiring new issuer/audience fields', async () => {
    const token = await new SignJWT({ id: 'synthetic-satflux-user', segment: { plan: 'free' } })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key)
    expect((await verifyEndUserJwt(token, secret)).id).toBe('synthetic-satflux-user')
    await expect(
      verifyEndUserJwt(token, 'different-project-secret-at-least-32-bytes'),
    ).rejects.toThrow()
  })

  test.each([
    'missing-exp',
    'missing-iat',
    'expired',
    'over-24h',
    'future-iat',
    'zero-ttl',
    'wrong-alg',
  ])('rejects %s', async (kind) => {
    const now = Math.floor(Date.now() / 1000)
    const claims: Record<string, unknown> = { id: 'synthetic-user', iat: now, exp: now + 3600 }
    if (kind === 'missing-exp') delete claims.exp
    if (kind === 'missing-iat') delete claims.iat
    if (kind === 'expired') claims.exp = now - 60
    if (kind === 'over-24h') claims.exp = now + 86_401
    if (kind === 'future-iat') claims.iat = now + 120
    if (kind === 'zero-ttl') claims.exp = now
    const token = await new SignJWT(claims)
      .setProtectedHeader({ alg: kind === 'wrong-alg' ? 'HS384' : 'HS256' })
      .sign(key)
    await expect(verifyEndUserJwt(token, secret)).rejects.toThrow()
  })
})

test('anonymous A-B-A project switches retain separate stable cookie identities', async () => {
  const jar = new Map<string, string>()
  async function create(project: typeof a) {
    const response = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: {
        'x-chorala-key': project.publicKey,
        'content-type': 'application/json',
        cookie: [...jar.values()].join('; '),
      },
      body: JSON.stringify({
        boardSlug: 'feature-requests',
        title: 'Synthetic identity test',
        body: '',
      }),
    })
    expect(response.status).toBe(201)
    const cookie = response.headers.get('set-cookie')?.split(';')[0]
    if (cookie) jar.set(cookie.split('=')[0] as string, cookie)
    const body = (await response.json()) as { post: { id: string } }
    const [row] = await db
      .select({ author: posts.authorEndUserId })
      .from(posts)
      .where(eq(posts.id, body.post.id))
    return row?.author
  }
  const firstA = await create(a)
  const firstB = await create(b)
  const secondA = await create(a)
  expect(firstA).toBeTruthy()
  expect(firstB).not.toBe(firstA)
  expect(secondA).toBe(firstA)
  expect(jar.has(`chorala_uid_${a.id}`)).toBe(true)
  expect(jar.has(`chorala_uid_${b.id}`)).toBe(true)
})

test('self-host registration is closed by default without creating an account', async () => {
  expect(env.CHORALA_ALLOW_SIGNUP).toBe(false)
  const email = `blocked-${randomUUID()}@example.test`
  const response = await app.request('/api/v1/auth/sign-up/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(env.CHORALA_PUBLIC_URL).origin },
    body: JSON.stringify({
      name: 'Synthetic blocked signup',
      email,
      password: 'synthetic-only-closed-registration-password',
    }),
  })
  expect([400, 403]).toContain(response.status)
  expect(await db.select({ id: users.id }).from(users).where(eq(users.email, email))).toHaveLength(
    0,
  )
})

test('a legacy cookie migrates only within its original project', async () => {
  async function create(project: typeof a, cookie = '') {
    const response = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { 'x-chorala-key': project.publicKey, 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        boardSlug: 'feature-requests',
        title: 'Synthetic legacy identity',
        body: '',
      }),
    })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { post: { id: string } }
    const [row] = await db
      .select({ author: posts.authorEndUserId })
      .from(posts)
      .where(eq(posts.id, body.post.id))
    return { author: row?.author, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' }
  }
  const original = await create(a)
  const legacy = original.cookie.replace(/^[^=]+=/, 'chorala_uid=')
  const foreign = await create(b, legacy)
  const migrated = await create(a, legacy)
  expect(foreign.author).not.toBe(original.author)
  expect(migrated.author).toBe(original.author)
  expect(migrated.cookie).toMatch(new RegExp(`^chorala_uid_${a.id}=`))
})

test('limiter outage rejects writes before persistence while public reads can degrade', async () => {
  const failure = vi
    .spyOn(redis, 'incr')
    .mockRejectedValueOnce(new Error('synthetic limiter outage'))
    .mockRejectedValueOnce(new Error('synthetic limiter outage'))
  try {
    const title = `must-not-persist-${randomUUID()}`
    const response = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { 'x-chorala-key': a.publicKey, 'content-type': 'application/json' },
      body: JSON.stringify({ boardSlug: 'feature-requests', title, body: '' }),
    })
    expect(response.status).toBe(503)
    expect(
      await db
        .select({ id: posts.id })
        .from(posts)
        .where(and(eq(posts.projectId, a.id), eq(posts.title, title))),
    ).toHaveLength(0)
    expect(
      (await app.request('/api/v1/public/boards', { headers: { 'x-chorala-key': a.publicKey } }))
        .status,
    ).toBe(200)
  } finally {
    failure.mockRestore()
  }
})
