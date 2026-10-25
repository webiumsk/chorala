import { env } from '@chorala/config'
import { attachments, companies, db, eq, projects } from '@chorala/db'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.ts'
import { redis } from '../src/lib/redis.ts'

const app = createApp()
let publicKey: string
let jwtSecret: string

const KEY = () => ({ 'x-chorala-key': publicKey })

async function signUser(claims: Record<string, unknown>) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(jwtSecret))
}

/** Pull the chorala_uid cookie out of a response so a follow-up request reuses the identity. */
function cookieFrom(res: Response): string | undefined {
  const set = res.headers.get('set-cookie')
  return set?.split(';')[0]
}

beforeAll(async () => {
  const [p] = await db.select().from(projects).where(eq(projects.slug, 'acme'))
  if (!p) throw new Error('seed project missing — run `pnpm db:seed`')
  publicKey = p.publicKey
  jwtSecret = p.endUserJwtSecret
})

afterAll(async () => {
  await redis.quit()
})

describe('project key + CORS', () => {
  test('missing X-Chorala-Key is 401', async () => {
    const res = await app.request('/api/v1/public/boards')
    expect(res.status).toBe(401)
  })

  test('reads boards + posts anonymously', async () => {
    const res = await app.request('/api/v1/public/boards', { headers: KEY() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { boards: unknown[]; posts: unknown[] }
    expect(body.boards.length).toBeGreaterThan(0)
    expect(body.posts.length).toBeGreaterThan(0)
  })

  test('disallowed Origin is rejected with 403', async () => {
    const res = await app.request('/api/v1/public/boards', {
      headers: { ...KEY(), origin: 'https://evil.example.com' },
    })
    expect(res.status).toBe(403)
  })

  test('allowed Origin echoes Access-Control-Allow-Origin', async () => {
    const res = await app.request('/api/v1/public/boards', {
      headers: { ...KEY(), origin: 'http://localhost:3000' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:3000')
  })

  test('the hosted Chorala origin is auto-allowed without whitelisting (first-party portal)', async () => {
    // The hosted portal at CHORALA_PUBLIC_URL must work without the customer adding
    // Chorala's own domain to allowed_origins — votes/comments/surveys from the
    // hosted portal would otherwise 403 (the Phase 16 survey-submit bug).
    const choralaOrigin = new URL(env.CHORALA_PUBLIC_URL).origin
    const res = await app.request('/api/v1/public/boards', {
      headers: { ...KEY(), origin: choralaOrigin },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe(choralaOrigin)
  })
})

describe('localization', () => {
  test('posts are overlaid with the requested locale', async () => {
    const res = await app.request('/api/v1/public/boards?locale=es', { headers: KEY() })
    const body = (await res.json()) as { posts: { displayLocale: string }[] }
    expect(body.posts.some((p) => p.displayLocale === 'es')).toBe(true)
  })
})

describe('anonymous flow (cookie identity)', () => {
  test('create → vote toggles → comment, reusing the anon cookie', async () => {
    // create
    const createRes = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ boardSlug: 'feature-requests', title: 'Anon idea', body: 'hi' }),
    })
    expect(createRes.status).toBe(201)
    const cookie = cookieFrom(createRes)
    expect(cookie).toContain('chorala_uid')
    const created = (await createRes.json()) as { post: { id: string } }
    const postId = created.post.id

    const withCookie = { ...KEY(), cookie: cookie as string, 'content-type': 'application/json' }

    // vote (add) then vote again (idempotent) then unvote
    const v1 = (await (
      await app.request(`/api/v1/public/posts/${postId}/vote`, {
        method: 'POST',
        headers: withCookie,
      })
    ).json()) as { voted: boolean; voteCount: number }
    expect(v1).toEqual({ voted: true, voteCount: 1 })
    const v2 = (await (
      await app.request(`/api/v1/public/posts/${postId}/vote`, {
        method: 'POST',
        headers: withCookie,
      })
    ).json()) as { voteCount: number }
    expect(v2.voteCount).toBe(1) // same anon user, still 1
    const v3 = (await (
      await app.request(`/api/v1/public/posts/${postId}/vote`, {
        method: 'DELETE',
        headers: withCookie,
      })
    ).json()) as { voted: boolean }
    expect(v3.voted).toBe(false)

    // comment
    const cRes = await app.request(`/api/v1/public/posts/${postId}/comments`, {
      method: 'POST',
      headers: withCookie,
      body: JSON.stringify({ body: 'first!' }),
    })
    expect(cRes.status).toBe(201)
  })
})

describe('submission context (appVersion + metadata)', () => {
  test('stores appVersion on the post and accepts a free-form metadata map', async () => {
    const res = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({
        boardSlug: 'feature-requests',
        title: 'Crash on export',
        body: 'repro inside',
        appVersion: '2.4.1',
        metadata: { platform: 'web', locale: 'en-GB', plan: 'pro' },
      }),
    })
    expect(res.status).toBe(201)
    const created = (await res.json()) as { post: { appVersion: string | null } }
    // appVersion is promoted to a first-class, public field…
    expect(created.post.appVersion).toBe('2.4.1')
    // …while the free-form metadata map is never leaked on the public payload.
    expect(JSON.stringify(created.post)).not.toContain('plan')
  })
})

describe('attachments (bug-report screenshots)', () => {
  // valid 1×1 PNG
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg=='

  test('uploads a screenshot, links it to a post, and rejects non-images', async () => {
    const up = await app.request('/api/v1/public/attachments', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl: PNG, kind: 'screenshot' }),
    })
    expect(up.status).toBe(201)
    const att = (await up.json()) as { id: string; mimeType: string; byteSize: number }
    expect(att.id).toMatch(/^att_/)
    expect(att.mimeType).toBe('image/png')
    expect(att.byteSize).toBeGreaterThan(0)

    // Reuse the anon identity cookie so the linking is correctly scoped to the same end-user.
    const cookie = cookieFrom(up)
    const create = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { ...KEY(), cookie: cookie as string, 'content-type': 'application/json' },
      body: JSON.stringify({
        boardSlug: 'feature-requests',
        title: 'Button overlaps footer',
        attachmentIds: [att.id],
      }),
    })
    expect(create.status).toBe(201)
    const { post } = (await create.json()) as { post: { id: string } }

    const [row] = await db.select().from(attachments).where(eq(attachments.id, att.id))
    expect(row?.postId).toBe(post.id) // linked on create

    // a non-image data URL is refused
    const bad = await app.request('/api/v1/public/attachments', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ dataUrl: 'data:application/pdf;base64,JVBERi0=' }),
    })
    expect(bad.status).toBe(400)
  })
})

describe('identified flow (host JWT)', () => {
  test('identify upserts an end-user; identified vote shows hasVoted', async () => {
    const jwt = await signUser({
      id: 'jwt-user-1',
      email: 'z@acme.com',
      name: 'Zed',
      segment: { plan: 'pro' },
    })

    const idRes = await app.request('/api/v1/public/identify', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ jwt }),
    })
    expect(idRes.status).toBe(200)
    const { endUser } = (await idRes.json()) as { endUser: { isAnonymous: boolean; email: string } }
    expect(endUser.isAnonymous).toBe(false)
    expect(endUser.email).toBe('z@acme.com')

    // find a post and vote as the identified user (no cookie, JWT header)
    const boards = (await (
      await app.request('/api/v1/public/boards', { headers: KEY() })
    ).json()) as { posts: { id: string }[] }
    const postId = boards.posts[0]!.id
    const userHeaders = { ...KEY(), 'x-chorala-user': jwt }
    await app.request(`/api/v1/public/posts/${postId}/vote`, {
      method: 'POST',
      headers: userHeaders,
    })

    const detail = (await (
      await app.request(`/api/v1/public/posts/${postId}`, { headers: userHeaders })
    ).json()) as { post: { hasVoted: boolean } }
    expect(detail.post.hasVoted).toBe(true)
  })

  test('an invalid JWT is rejected with 401', async () => {
    const res = await app.request('/api/v1/public/identify', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ jwt: 'definitely.not.valid' }),
    })
    expect(res.status).toBe(401)
  })

  test('a company in the JWT upserts the account and links the end-user (Phase 11)', async () => {
    const jwt = await signUser({
      id: 'jwt-buyer-1',
      email: 'buyer@globex.com',
      company: { id: 'globex', name: 'Globex Corp', mrr: 4200, plan: 'enterprise' },
    })
    const res = await app.request('/api/v1/public/identify', {
      method: 'POST',
      headers: { ...KEY(), 'content-type': 'application/json' },
      body: JSON.stringify({ jwt }),
    })
    expect(res.status).toBe(200)
    const { endUser } = (await res.json()) as { endUser: { id: string; companyId: string | null } }
    expect(endUser.companyId).toMatch(/^co_/)

    const [co] = await db
      .select()
      .from(companies)
      .where(eq(companies.id, endUser.companyId as string))
    expect(co?.externalId).toBe('globex')
    expect(co?.mrr).toBe(4200)
    expect(co?.plan).toBe('enterprise')
  })
})

describe('rate limiting', () => {
  test('exceeding the per-minute limit returns 429', async () => {
    const limit = env.CHORALA_RATE_LIMIT_PUBLIC
    const ip = '203.0.113.77' // dedicated IP so this test owns its window
    let last = 200
    for (let i = 0; i < limit + 1; i++) {
      const res = await app.request('/api/v1/public/changelog', {
        headers: { ...KEY(), 'x-forwarded-for': ip },
      })
      last = res.status
    }
    expect(last).toBe(429)
  })
})
