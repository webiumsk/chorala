import {
  type AuthContext,
  apiKeys,
  boards as boardSvc,
  integrations,
  posts as postSvc,
  projects,
} from '@chorala/core'
import { db, eq, members, projects as projectsTable } from '@chorala/db'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import { createApp } from '../src/app.ts'
import { redis } from '../src/lib/redis.ts'

const app = createApp()
let auth: Record<string, string>
let projectId: string
let boardId: string
let publicKey: string
let ctx: AuthContext

beforeAll(async () => {
  // Build a session ctx from the seed org, then spin up an isolated throwaway project.
  const [acme] = await db.select().from(projectsTable).where(eq(projectsTable.slug, 'acme'))
  if (!acme) throw new Error('seed project missing — run `pnpm db:seed`')
  const [m] = await db.select().from(members).where(eq(members.orgId, acme.orgId))
  if (!m) throw new Error('no member for the seed org')
  ctx = {
    kind: 'session',
    orgId: acme.orgId,
    userId: m.userId,
    memberId: m.id,
    role: m.role,
  }
  const project = await projects.createProject(ctx, {
    name: 'Admin Test',
    slug: `admin-test-${Date.now()}`,
    isPublic: true,
    allowedOrigins: [],
  })
  projectId = project!.id
  publicKey = project!.publicKey
  boardId = (await boardSvc.listBoards(ctx, projectId))[0]!.id
  await postSvc.createPost(ctx, projectId, { boardId, title: 'Seed post', body: '' })
  const key = await apiKeys.createApiKey(ctx, projectId, {
    name: 'test',
    scopes: ['read', 'write'],
  })
  auth = { authorization: `Bearer ${key.key}`, 'content-type': 'application/json' }
})

afterAll(async () => {
  await db.delete(projectsTable).where(eq(projectsTable.id, projectId)) // cascades
  await redis.quit()
})

const base = () => `/api/v1/projects/${projectId}`

describe('admin auth', () => {
  test('a bad bearer token is rejected', async () => {
    const res = await app.request(`${base()}/posts`, {
      headers: { authorization: 'Bearer hk_nope' },
    })
    expect(res.status).toBe(401)
  })
})

describe('score fields (Phase 12)', () => {
  test('CRUD + the score shows up on the post list', async () => {
    const create = await app.request(`${base()}/score-fields`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ key: 'reach', label: 'Reach', weight: 2 }),
    })
    expect(create.status).toBe(201)
    const field = (await create.json()) as { id: string; key: string }
    expect(field.key).toBe('reach')

    const list = await app.request(`${base()}/score-fields`, { headers: auth })
    expect(((await list.json()) as unknown[]).length).toBe(1)

    // set a value on the seed post and confirm score = value × weight
    const posts = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
    }[]
    await app.request(`${base()}/posts/${posts[0]!.id}`, {
      method: 'PATCH',
      headers: auth,
      body: JSON.stringify({ fields: { reach: 5 } }),
    })
    const scored = (await (
      await app.request(`${base()}/posts?sort=score`, { headers: auth })
    ).json()) as { score: number }[]
    expect(scored[0]!.score).toBe(10)

    const del = await app.request(`${base()}/score-fields/${field.id}`, {
      method: 'DELETE',
      headers: auth,
    })
    expect(del.status).toBe(200)
  })
})

describe('segments (Phase 13)', () => {
  test('preview + create + list', async () => {
    const preview = await app.request(`${base()}/segments/preview`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] }),
    })
    expect(preview.status).toBe(200)
    expect((await preview.json()) as { matchCount: number }).toHaveProperty('matchCount')

    const create = await app.request(`${base()}/segments`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'Pros',
        definition: { match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] },
      }),
    })
    expect(create.status).toBe(201)
    const list = (await (await app.request(`${base()}/segments`, { headers: auth })).json()) as {
      matchCount: number
    }[]
    expect(list).toHaveLength(1)
    expect(list[0]).toHaveProperty('matchCount')
  })
})

describe('companies + CSV export', () => {
  test('companies list is an (empty) array', async () => {
    const res = await app.request(`${base()}/companies`, { headers: auth })
    expect(res.status).toBe(200)
    expect(Array.isArray(await res.json())).toBe(true)
  })

  test('CSV export returns text/csv with a header row', async () => {
    const res = await app.request(`${base()}/posts?format=csv`, { headers: auth })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/csv')
    const body = await res.text()
    expect(body.split('\n')[0]).toContain('Title,Board,Status,Votes')
  })
})

describe('autopilot (Phase 14)', () => {
  test('ingest → pending review → approve → live; ask returns sources', async () => {
    const ingest = await app.request(`${base()}/ingest`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        source: 'intercom',
        text: 'We really need bulk CSV export of all ideas.',
      }),
    })
    expect(ingest.status).toBe(201)
    const { created } = (await ingest.json()) as { created: { id: string; reviewStatus: string }[] }
    expect(created).toHaveLength(1) // AI off in tests → one captured request
    const newId = created[0]!.id
    expect(created[0]!.reviewStatus).toBe('pending')

    // it's in the review queue, not the default (live) list
    const queue = (await (
      await app.request(`${base()}/posts?review=pending`, { headers: auth })
    ).json()) as { id: string }[]
    expect(queue.some((p) => p.id === newId)).toBe(true)
    const live = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
    }[]
    expect(live.some((p) => p.id === newId)).toBe(false)

    // approve → now live
    const ok = await app.request(`${base()}/posts/${newId}/approve`, {
      method: 'POST',
      headers: auth,
    })
    expect(ok.status).toBe(200)
    const live2 = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
    }[]
    expect(live2.some((p) => p.id === newId)).toBe(true)

    // ask your feedback (keyword fallback when AI is off) finds it
    const ask = await app.request(`${base()}/ask`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ question: 'export csv' }),
    })
    expect(ask.status).toBe(200)
    const res = (await ask.json()) as { sources: { id: string }[]; aiEnabled: boolean }
    expect(res.sources.some((s) => s.id === newId)).toBe(true)
  })
})

describe('inbound webhook (Phase 15)', () => {
  test('Bearer-secured identify upserts an end-user; a bad secret is 401', async () => {
    const { secret } = await integrations.setSegmentIntegration(ctx, projectId)
    const ok = await app.request(`/api/v1/inbound/${projectId}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'identify', userId: 'cdp-1', traits: { email: 'cdp@x.com' } }),
    })
    expect(ok.status).toBe(200)
    expect((await ok.json()) as { processed: string }).toEqual({ processed: 'identify' })

    const bad = await app.request(`/api/v1/inbound/${projectId}`, {
      method: 'POST',
      headers: { authorization: 'Bearer nope', 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'identify', userId: 'cdp-2' }),
    })
    expect(bad.status).toBe(401)
  })
})

describe('surveys (Phase 16)', () => {
  test('create → public sees it & submits → results aggregate', async () => {
    const create = await app.request(`${base()}/surveys`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        name: 'NPS',
        type: 'nps',
        question: 'How likely…?',
        config: { scaleMin: 0, scaleMax: 10 },
        isActive: true,
      }),
    })
    expect(create.status).toBe(201)
    const survey = (await create.json()) as { id: string }

    // a public visitor is shown the active survey…
    const active = await app.request('/api/v1/public/survey', {
      headers: { 'x-chorala-key': publicKey },
    })
    expect(((await active.json()) as { id: string }).id).toBe(survey.id)

    // …and submits a promoter score
    const resp = await app.request(`/api/v1/public/survey/${survey.id}/responses`, {
      method: 'POST',
      headers: { 'x-chorala-key': publicKey, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 10 }),
    })
    expect(resp.status).toBe(201)

    const results = (await (
      await app.request(`${base()}/surveys/${survey.id}/results`, { headers: auth })
    ).json()) as { responseCount: number; nps: number }
    expect(results.responseCount).toBe(1)
    expect(results.nps).toBe(100) // one promoter
  })
})

describe('AI depth — Autopilot v2 (Phase 20)', () => {
  test('draft-reply, suggest-tags, digest preview + sentiment all work (AI off)', async () => {
    const posts = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
      sentimentLabel: string | null
    }[]
    const postId = posts[0]!.id
    // every post is sentiment-scored at create time (deterministic lexicon)
    expect(posts.every((p) => p.sentimentLabel !== undefined)).toBe(true)

    // smart-reply: templated draft mentions the post
    const reply = await app.request(`${base()}/posts/${postId}/draft-reply`, {
      method: 'POST',
      headers: auth,
    })
    expect(reply.status).toBe(200)
    const { draft, aiEnabled } = (await reply.json()) as { draft: string; aiEnabled: boolean }
    expect(aiEnabled).toBe(false)
    expect(draft.length).toBeGreaterThan(10)

    // auto-categorize: create a tag, then suggest-tags applies it to a matching post
    await app.request(`${base()}/tags`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ name: 'export', color: '#abc' }),
    })
    await app.request(`${base()}/posts`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ boardId, title: 'Please add CSV export', body: 'export everything' }),
    })
    const all = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
      title: string
    }[]
    const exportPost = all.find((p) => p.title.includes('CSV export'))!
    const sug = await app.request(`${base()}/posts/${exportPost.id}/suggest-tags`, {
      method: 'POST',
      headers: auth,
    })
    expect(sug.status).toBe(200)
    expect(((await sug.json()) as { suggested: unknown[] }).suggested.length).toBeGreaterThan(0)

    // weekly digest preview
    const digest = await app.request(`${base()}/digest/preview`, { headers: auth })
    expect(digest.status).toBe(200)
    const d = (await digest.json()) as { narrative: string; sentiment: { negative: number } }
    expect(d.narrative).toBeTruthy()

    // analytics carries the sentiment breakdown
    const analytics = (await (
      await app.request(`${base()}/analytics?timeframe=all`, { headers: auth })
    ).json()) as { sentiment: { positive: number; neutral: number; negative: number } }
    expect(analytics.sentiment).toHaveProperty('neutral')
  })
})

describe('insights + analytics (Phase 19)', () => {
  test('link an insight to the seed post → it ranks in analytics; CSV exports', async () => {
    const posts = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
    }[]
    const postId = posts[0]!.id

    const add = await app.request(`${base()}/insights`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ postId, quote: 'We would pay for this.', source: 'sales' }),
    })
    expect(add.status).toBe(201)

    const list = (await (
      await app.request(`${base()}/insights?postId=${postId}`, { headers: auth })
    ).json()) as { id: string }[]
    expect(list).toHaveLength(1)

    const analytics = (await (
      await app.request(`${base()}/analytics?timeframe=all`, { headers: auth })
    ).json()) as {
      summary: { posts: number }
      mostEvidenced: { id: string; insightCount: number }[]
      boardHealth: unknown[]
    }
    expect(analytics.summary.posts).toBeGreaterThanOrEqual(1)
    expect(analytics.mostEvidenced.find((m) => m.id === postId)?.insightCount).toBe(1)
    expect(analytics.boardHealth.length).toBeGreaterThan(0)

    const csv = await app.request(`${base()}/analytics?timeframe=all&format=csv`, { headers: auth })
    expect(csv.headers.get('content-type')).toContain('text/csv')
    expect(await csv.text()).toContain('Board,Total,Open')
  })
})

describe('moderation + audit (Phase 17)', () => {
  test('a spammy public post lands in the queue → hide → 200', async () => {
    // public submission via the widget API (spam heuristic flags it)
    const submit = await app.request('/api/v1/public/posts', {
      method: 'POST',
      headers: { 'x-chorala-key': publicKey, 'content-type': 'application/json' },
      body: JSON.stringify({
        boardSlug: 'feature-requests',
        title: 'FREE MONEY casino bonus',
        body: 'buy now, click here, limited offer',
      }),
    })
    expect(submit.status).toBe(201)

    const queue = (await (await app.request(`${base()}/moderation`, { headers: auth })).json()) as {
      posts: { id: string; flaggedReason: string }[]
    }
    expect(queue.posts.length).toBeGreaterThanOrEqual(1)
    const flagged = queue.posts[0]!
    expect(flagged.flaggedReason).toBeTruthy()

    const hide = await app.request(`${base()}/moderation/posts/${flagged.id}`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'hide' }),
    })
    expect(hide.status).toBe(200)

    // hidden post is no longer publicly reachable
    const pub = await app.request('/api/v1/public/boards', {
      headers: { 'x-chorala-key': publicKey },
    })
    const body = (await pub.json()) as { posts: { id: string }[] }
    expect(body.posts.some((p) => p.id === flagged.id)).toBe(false)
  })

  test('a project API key cannot read the organization-wide audit log', async () => {
    const res = await app.request('/api/v1/org/audit-log', { headers: auth })
    expect(res.status).toBe(403)
  })
})

describe('vote on behalf (Phase 12)', () => {
  test('records a vote for a customer by email', async () => {
    const posts = (await (await app.request(`${base()}/posts`, { headers: auth })).json()) as {
      id: string
    }[]
    const res = await app.request(`${base()}/posts/${posts[0]!.id}/vote-for`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ email: 'buyer@acme.com' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { voted: boolean; voteCount: number }
    expect(body.voted).toBe(true)
    expect(body.voteCount).toBe(1)
  })
})
