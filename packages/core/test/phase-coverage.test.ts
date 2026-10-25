import { randomUUID } from 'node:crypto'
import {
  and,
  client,
  companies,
  db,
  endUsers,
  eq,
  members,
  newId,
  organizations,
  posts as postsTable,
  users,
} from '@chorala/db'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'
import {
  type AuthContext,
  analytics,
  audit,
  boards,
  canManageOrg,
  canModerate,
  changelog,
  comments as commentSvc,
  companies as companySvc,
  endUsers as endUserSvc,
  insights,
  integrations,
  moderation,
  posts,
  projects,
  publicFeed,
  segments,
  storage,
  surveys,
  tags,
  votes,
} from '../src/index.ts'

let ctx: AuthContext
let orgId: string
let userId: string

// A valid 1×1 PNG data URL.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4////fwAJ+wP9CNHoHgAAAABJRU5ErkJggg=='

async function newProject(slug: string) {
  const p = await projects.createProject(ctx, {
    name: slug,
    slug: `${slug}-${randomUUID().slice(0, 6)}`,
    isPublic: true,
    allowedOrigins: [],
  })
  if (!p) throw new Error('project create failed')
  return p
}
const boardId = async (pid: string) => (await boards.listBoards(ctx, pid))[0]!.id

/** Insert an identified end-user directly (optionally in a company). */
async function mkUser(
  pid: string,
  over: Partial<typeof endUsers.$inferInsert> = {},
): Promise<string> {
  const id = newId('endUser')
  await db.insert(endUsers).values({ id, projectId: pid, isAnonymous: false, ...over })
  return id
}

beforeAll(async () => {
  orgId = newId('organization')
  userId = newId('user')
  const slug = `cov-${randomUUID().slice(0, 8)}`
  await db.insert(organizations).values({ id: orgId, slug, name: 'Coverage Org' })
  await db.insert(users).values({ id: userId, name: 'T', email: `${slug}@example.com` })
  const memberId = newId('member')
  await db.insert(members).values({ id: memberId, orgId, userId, role: 'owner' })
  ctx = { kind: 'session', orgId, userId, memberId, role: 'owner' }
})

afterAll(async () => {
  await db.delete(organizations).where(eq(organizations.id, orgId))
  await db.delete(users).where(eq(users.id, userId))
  await client.end()
})

describe('companies + identify (Phase 11)', () => {
  test('identify upserts a company, links the user, and is idempotent', async () => {
    const p = await newProject('ident')
    const eu1 = await endUserSvc.upsertFromIdentity(p.id, {
      id: 'u-1',
      email: 'a@globex.com',
      company: { id: 'globex', name: 'Globex', mrr: 1000, plan: 'pro' },
    })
    expect(eu1.companyId).toMatch(/^co_/)

    // a second identify for the same external company updates MRR, does not duplicate
    await endUserSvc.upsertFromIdentity(p.id, {
      id: 'u-2',
      email: 'b@globex.com',
      company: { id: 'globex', mrr: 2500 },
    })
    const cos = await db.select().from(companies).where(eq(companies.projectId, p.id))
    expect(cos).toHaveLength(1)
    expect(cos[0]!.mrr).toBe(2500)
  })

  test('listCompanies rollups (users + posts)', async () => {
    const p = await newProject('rollup')
    const co = newId('company')
    await db
      .insert(companies)
      .values({ id: co, projectId: p.id, name: 'Initech', plan: 'pro', mrr: 9000 })
    const u1 = await mkUser(p.id, { companyId: co, email: 'p1@initech.com' })
    await mkUser(p.id, { companyId: co, email: 'p2@initech.com' })
    await posts.createPost(ctx, p.id, {
      boardId: await boardId(p.id),
      title: 'From Initech',
      body: '',
    })
    // attribute a post to u1 (createPost is admin-authored, so set author directly)
    const postId = newId('post')
    await db.insert(postsTable).values({
      id: postId,
      projectId: p.id,
      boardId: await boardId(p.id),
      title: 'Initech idea',
      authorEndUserId: u1,
    })
    const list = await companySvc.listCompanies(ctx, p.id)
    const row = list.find((c) => c.id === co)!
    expect(row.userCount).toBe(2)
    expect(row.postCount).toBe(1)
  })

  test('updateCompany edits MRR/plan; getPostCustomer returns author + company', async () => {
    const p = await newProject('cust')
    const co = newId('company')
    await db
      .insert(companies)
      .values({ id: co, projectId: p.id, name: 'Hooli', plan: 'free', mrr: 0 })
    await companySvc.updateCompany(ctx, p.id, co, { mrr: 4200, plan: 'enterprise' })
    const after = await companySvc.getCompany(ctx, p.id, co)
    expect(after.mrr).toBe(4200)
    expect(after.plan).toBe('enterprise')

    const eu = await mkUser(p.id, { companyId: co, name: 'Gavin', email: 'gavin@hooli.com' })
    const postId = newId('post')
    await db.insert(postsTable).values({
      id: postId,
      projectId: p.id,
      boardId: await boardId(p.id),
      title: 'q',
      authorEndUserId: eu,
    })
    const customer = await posts.getPostCustomer(ctx, p.id, postId)
    expect(customer.endUser?.name).toBe('Gavin')
    expect(customer.company?.id).toBe(co)
    expect(customer.company?.mrr).toBe(4200)
  })
})

describe('revenue impact + author-company filters (Phase 11)', () => {
  test('revenueImpact counts each company once; filters target the author', async () => {
    const p = await newProject('rev')
    const coA = newId('company')
    const coB = newId('company')
    await db.insert(companies).values([
      { id: coA, projectId: p.id, name: 'A', plan: 'pro', mrr: 1000 },
      { id: coB, projectId: p.id, name: 'B', plan: 'free', mrr: 500 },
    ])
    const a1 = await mkUser(p.id, { companyId: coA, email: 'a1@a.com' })
    const a2 = await mkUser(p.id, { companyId: coA, email: 'a2@a.com' })
    const b1 = await mkUser(p.id, { companyId: coB, email: 'b1@b.com' })

    // a post authored by a pro-company (A) user; all three vote on it
    const postId = newId('post')
    await db.insert(postsTable).values({
      id: postId,
      projectId: p.id,
      boardId: await boardId(p.id),
      title: 'Wanted',
      authorEndUserId: a1,
    })
    for (const eu of [a1, a2, b1]) await votes.setVote(p.id, postId, eu, true)

    const ranked = await posts.listPosts(ctx, p.id, {})
    const row = ranked.find((r) => r.id === postId)!
    expect(row.voteCount).toBe(3)
    expect(row.revenueImpact).toBe(1500) // A (1000, counted once for 2 voters) + B (500)

    // author-company filters operate on the post AUTHOR's company (A = pro)
    expect((await posts.listPosts(ctx, p.id, { plan: 'pro' })).some((r) => r.id === postId)).toBe(
      true,
    )
    expect((await posts.listPosts(ctx, p.id, { plan: 'free' })).some((r) => r.id === postId)).toBe(
      false,
    )
    expect((await posts.listPosts(ctx, p.id, { minMrr: 800 })).some((r) => r.id === postId)).toBe(
      true,
    )
    expect((await posts.listPosts(ctx, p.id, { minMrr: 5000 })).some((r) => r.id === postId)).toBe(
      false,
    )
  })
})

describe('attachments (Phase 10)', () => {
  test('upload decodes + sizes + dims; rejects non-images and junk', async () => {
    const p = await newProject('att')
    const eu = await mkUser(p.id, { email: 'rep@x.com' })
    const att = await storage.createPublicAttachment(p.id, eu, { dataUrl: PNG, kind: 'screenshot' })
    expect(att.mimeType).toBe('image/png')
    expect(att.byteSize).toBeGreaterThan(0)
    expect(att.width).toBe(1)
    expect(att.height).toBe(1)
    expect(await storage.projectStorageUsage(p.id)).toBe(att.byteSize)

    await expect(
      storage.createPublicAttachment(p.id, eu, {
        dataUrl: 'data:application/pdf;base64,JVBERi0=',
        kind: 'file',
      }),
    ).rejects.toThrow()
    await expect(
      storage.createPublicAttachment(p.id, eu, { dataUrl: 'not-a-data-url', kind: 'file' }),
    ).rejects.toThrow()
  })

  test('link is scoped to the uploader; admin can list + read bytes', async () => {
    const p = await newProject('attlink')
    const owner = await mkUser(p.id, { email: 'owner@x.com' })
    const other = await mkUser(p.id, { email: 'other@x.com' })
    const att = await storage.createPublicAttachment(p.id, owner, {
      dataUrl: PNG,
      kind: 'screenshot',
    })
    const postId = newId('post')
    await db
      .insert(postsTable)
      .values({ id: postId, projectId: p.id, boardId: await boardId(p.id), title: 'bug' })

    // a different end-user cannot attach the owner's upload
    await storage.linkAttachmentsToPost(p.id, other, [att.id], postId)
    expect(await storage.listAttachmentsForPost(ctx, p.id, postId)).toHaveLength(0)
    // the owner can
    await storage.linkAttachmentsToPost(p.id, owner, [att.id], postId)
    const linked = await storage.listAttachmentsForPost(ctx, p.id, postId)
    expect(linked).toHaveLength(1)

    const bytes = await storage.readAttachment(ctx, p.id, att.id)
    expect(bytes.mimeType).toBe('image/png')
    expect(bytes.bytes.byteLength).toBe(att.byteSize)
  })
})

describe('segment resolver matrix (Phase 13)', () => {
  test('every field + match all/any + empty rules', async () => {
    const p = await newProject('seg')
    const coPro = newId('company')
    const coFree = newId('company')
    await db.insert(companies).values([
      { id: coPro, projectId: p.id, name: 'Pro Inc', plan: 'pro', mrr: 5000 },
      { id: coFree, projectId: p.id, name: 'Free Inc', plan: 'free', mrr: 0 },
    ])
    await mkUser(p.id, { email: 'ann@acme.com', locale: 'en', companyId: coPro })
    await mkUser(p.id, { email: 'bea@acme.fr', locale: 'fr', companyId: coPro })
    await mkUser(p.id, { email: 'cy@other.com', locale: 'en', companyId: coFree })
    await mkUser(p.id, { email: 'dan@nowhere.com', locale: 'en' }) // no company

    const m = async (
      rules: { field: string; op: string; value: string }[],
      match: 'all' | 'any' = 'all',
    ) =>
      // biome-ignore lint/suspicious/noExplicitAny: test passes a literal definition
      segments.matchCount(p.id, { match, rules } as any)

    expect(await m([{ field: 'plan', op: 'eq', value: 'pro' }])).toBe(2)
    expect(await m([{ field: 'plan', op: 'neq', value: 'pro' }])).toBe(1) // free (the no-company user has null plan)
    expect(await m([{ field: 'mrr', op: 'gte', value: '1000' }])).toBe(2)
    expect(await m([{ field: 'mrr', op: 'lt', value: '1000' }])).toBe(2) // free(0) + no-company(0)
    expect(await m([{ field: 'locale', op: 'eq', value: 'fr' }])).toBe(1)
    expect(await m([{ field: 'email_domain', op: 'eq', value: 'acme.com' }])).toBe(1)
    expect(await m([{ field: 'has_company', op: 'eq', value: 'true' }])).toBe(3)
    expect(await m([{ field: 'has_company', op: 'eq', value: 'false' }])).toBe(1)

    // match any: pro OR french-locale
    expect(
      await m(
        [
          { field: 'plan', op: 'eq', value: 'free' },
          { field: 'locale', op: 'eq', value: 'fr' },
        ],
        'any',
      ),
    ).toBe(2) // cy (free) + bea (fr)

    // empty rules → everyone
    expect(await m([])).toBe(4)

    // resolveSegment respects withEmailOnly + returns attributes for variables
    const recips = await segments.resolveSegment(
      p.id,
      // biome-ignore lint/suspicious/noExplicitAny: literal definition
      { match: 'all', rules: [{ field: 'email_domain', op: 'eq', value: 'acme.fr' }] } as any,
      { withEmailOnly: true },
    )
    expect(recips).toHaveLength(1)
    expect(recips[0]!.plan).toBe('pro')
    expect(recips[0]!.companyName).toBe('Pro Inc')
  })
})

describe('autopilot review queue (Phase 14)', () => {
  test('ingested posts are pending, hidden publicly, and approvable/dismissable', async () => {
    const p = await newProject('autopilot')
    const a = await posts.createReviewPost(ctx, p.id, {
      title: 'Bulk export to CSV',
      body: 'from a support chat',
      source: { type: 'intercom' },
    })
    const b = await posts.createReviewPost(ctx, p.id, {
      title: 'Dark mode please',
      body: 'second ticket',
      source: { type: 'zendesk' },
    })
    expect(a.reviewStatus).toBe('pending')

    // default admin list excludes pending; the review queue shows them
    const live = await posts.listPosts(ctx, p.id, {})
    expect(live.some((r) => r.id === a.id)).toBe(false)
    const queue = await posts.listPosts(ctx, p.id, { reviewStatus: 'pending' })
    expect(queue.map((r) => r.id).sort()).toEqual([a.id, b.id].sort())

    // the public board never shows pending drafts
    const pub = await publicFeed.listPublicBoards(p.id, {})
    expect(pub.posts.some((r) => r.id === a.id)).toBe(false)

    // approve → live (public + admin); dismiss → gone from the queue, never public
    await posts.approvePost(ctx, p.id, a.id)
    await posts.dismissPost(ctx, p.id, b.id)
    expect((await posts.listPosts(ctx, p.id, {})).some((r) => r.id === a.id)).toBe(true)
    expect((await publicFeed.listPublicBoards(p.id, {})).posts.some((r) => r.id === a.id)).toBe(
      true,
    )
    expect(await posts.listPosts(ctx, p.id, { reviewStatus: 'pending' })).toHaveLength(0)
    expect(
      (await posts.listPosts(ctx, p.id, { reviewStatus: 'dismissed' })).some((r) => r.id === b.id),
    ).toBe(true)
  })
})

describe('integrations breadth (Phase 15)', () => {
  test('inbound identify/group upsert end-users + companies and link them', async () => {
    const p = await newProject('inbound')
    // identify → end-user with traits saved to `segment`
    await integrations.processInbound(p.id, {
      type: 'identify',
      userId: 'u-77',
      traits: { email: 'kira@acme.com', name: 'Kira', plan: 'pro' },
    })
    const [eu] = await db
      .select()
      .from(endUsers)
      .where(and(eq(endUsers.projectId, p.id), eq(endUsers.externalId, 'u-77')))
    expect(eu?.email).toBe('kira@acme.com')
    expect((eu?.segment as { plan?: string }).plan).toBe('pro')

    // group → company upsert + the user linked to it
    await integrations.processInbound(p.id, {
      type: 'group',
      userId: 'u-77',
      groupId: 'acme',
      traits: { name: 'Acme Inc', plan: 'enterprise', mrr: 7000 },
    })
    const [co] = await db
      .select()
      .from(companies)
      .where(and(eq(companies.projectId, p.id), eq(companies.externalId, 'acme')))
    expect(co?.mrr).toBe(7000)
    const [linked] = await db.select().from(endUsers).where(eq(endUsers.externalId, 'u-77'))
    expect(linked?.companyId).toBe(co?.id)

    // other event types are ignored
    expect((await integrations.processInbound(p.id, { type: 'track' })).processed).toBe('ignored')
  })

  test('inbound secret round-trips; Discord URL is validated', async () => {
    const p = await newProject('secrets')
    const { secret, url } = await integrations.setSegmentIntegration(ctx, p.id)
    expect(url).toContain(`/inbound/${p.id}`)
    expect(await integrations.verifyInboundSecret(p.id, secret)).toBe(true)
    expect(await integrations.verifyInboundSecret(p.id, 'wrong')).toBe(false)

    // notifyDiscord on an unconnected project is a no-op (no network call)
    await integrations.notifyDiscord(p.id, 'hello')

    await expect(
      integrations.setDiscordIntegration(ctx, p.id, 'http://evil.com/x'),
    ).rejects.toThrow()
    await integrations.setDiscordIntegration(ctx, p.id, 'https://discord.com/api/webhooks/123/abc')
    const list = await integrations.listIntegrations(ctx, p.id)
    expect(list.some((i) => i.type === 'discord')).toBe(true)
  })
})

describe('surveys (Phase 16)', () => {
  test('NPS results compute; active survey de-dupes after a response', async () => {
    const p = await newProject('survey')
    const s = await surveys.createSurvey(ctx, p.id, {
      name: 'Q3 NPS',
      type: 'nps',
      question: 'How likely…?',
      config: { scaleMin: 0, scaleMax: 10 },
      isActive: true,
    })
    const eu1 = await mkUser(p.id, { email: 's1@x.com' })
    const eu2 = await mkUser(p.id, { email: 's2@x.com' })
    const eu3 = await mkUser(p.id, { email: 's3@x.com' })

    // shown to a fresh user…
    expect((await surveys.getActiveSurvey(p.id, eu1))?.id).toBe(s!.id)

    await surveys.submitResponse(p.id, s!.id, eu1, { value: 10 }) // promoter
    await surveys.submitResponse(p.id, s!.id, eu2, { value: 9 }) // promoter
    await surveys.submitResponse(p.id, s!.id, eu3, { value: 0 }) // detractor
    // a second submit from the same user is ignored (one response per user)
    await surveys.submitResponse(p.id, s!.id, eu1, { value: 1 })

    // …but not again once they've answered
    expect(await surveys.getActiveSurvey(p.id, eu1)).toBeNull()

    const r = await surveys.getResults(ctx, p.id, s!.id)
    expect(r.responseCount).toBe(3)
    expect(r.nps).toBe(33) // (2 promoters − 1 detractor) / 3 → 33
    expect(r.distribution).toEqual({ '0': 1, '9': 1, '10': 1 })
  })

  test('a targeted survey only shows to matching users', async () => {
    const p = await newProject('survey-seg')
    const co = newId('company')
    await db.insert(companies).values({ id: co, projectId: p.id, name: 'Pro', plan: 'pro', mrr: 9 })
    const pro = await mkUser(p.id, { email: 'pro@x.com', companyId: co })
    const free = await mkUser(p.id, { email: 'free@x.com' })
    const seg = await segments.createSegment(ctx, p.id, {
      name: 'Pros',
      definition: { match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] },
    })
    const s = await surveys.createSurvey(ctx, p.id, {
      name: 'Pro CSAT',
      type: 'csat',
      question: 'Happy?',
      config: { scaleMin: 1, scaleMax: 5 },
      segmentId: seg!.id,
      isActive: true,
    })
    expect((await surveys.getActiveSurvey(p.id, pro))?.id).toBe(s!.id)
    expect(await surveys.getActiveSurvey(p.id, free)).toBeNull()
    expect(await surveys.getActiveSurvey(p.id, undefined)).toBeNull() // anon, targeted
  })
})

describe('changelog targeting (Phase 13)', () => {
  test('createChangelog stores the segmentId', async () => {
    const p = await newProject('cl')
    const seg = await segments.createSegment(ctx, p.id, {
      name: 'Pros',
      definition: { match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] },
    })
    const entry = await changelog.createChangelog(ctx, p.id, {
      title: 'For {{plan}} users',
      body: 'hi {{first_name}}',
      status: 'draft',
      labels: [],
      linkedPostIds: [],
      segmentId: seg!.id,
    })
    expect(entry?.segmentId).toBe(seg!.id)
    expect(entry?.recipientCount).toBe(0)
  })
})

describe('roles & moderation (Phase 17)', () => {
  test('canManageOrg vs canModerate by role + apikey scope', () => {
    const sess = (role: 'owner' | 'admin' | 'moderator' | 'member'): AuthContext => ({
      kind: 'session',
      orgId,
      role,
    })
    expect(canManageOrg(sess('admin'))).toBe(true)
    expect(canManageOrg(sess('moderator'))).toBe(false)
    expect(canModerate(sess('moderator'))).toBe(true)
    expect(canModerate(sess('member'))).toBe(false)
    // API keys: only a write-scoped key may moderate.
    expect(canModerate({ kind: 'apikey', orgId, scopes: ['write'] })).toBe(true)
    expect(canModerate({ kind: 'apikey', orgId, scopes: ['read'] })).toBe(false)
  })

  test('detectSpam flags suspicious text, passes clean text', () => {
    expect(moderation.detectSpam('A perfectly reasonable feature request')).toBeNull()
    expect(moderation.detectSpam('Cheap loan, click here for free money!!!')).toBeTruthy()
    expect(
      moderation.detectSpam('http://a.co http://b.co http://c.co http://d.co http://e.co'),
    ).toBe('Excessive links')
  })

  test('hiding a post removes it from the public board; unhide restores it', async () => {
    const p = await newProject('mod')
    const eu = await mkUser(p.id)
    const { post } = await publicFeed.createPublicPost(p.id, eu, {
      boardSlug: 'feature-requests',
      title: 'Genuine idea',
      body: 'please add dark mode',
    })
    const id = post!.id
    const visible = async () =>
      (await publicFeed.listPublicBoards(p.id)).posts.some((x) => x.id === id)
    expect(await visible()).toBe(true)

    await moderation.moderatePost(ctx, p.id, id, 'hide')
    expect(await visible()).toBe(false)
    await expect(publicFeed.getPublicPost(p.id, id)).rejects.toThrow()

    await moderation.moderatePost(ctx, p.id, id, 'unhide')
    expect(await visible()).toBe(true)
  })

  test('a spammy submission is flagged and lands in the moderation queue', async () => {
    const p = await newProject('mod-spam')
    const eu = await mkUser(p.id)
    await publicFeed.createPublicPost(p.id, eu, {
      boardSlug: 'feature-requests',
      title: 'WIN A FREE CASINO BONUS',
      body: 'buy now, limited offer, click here',
    })
    const queue = await moderation.listModerationQueue(ctx, p.id)
    expect(queue.posts).toHaveLength(1)
    expect(queue.posts[0]!.flaggedReason).toBeTruthy()
  })

  test('hiding a comment drops it from the thread and the comment count', async () => {
    const p = await newProject('mod-c')
    const eu = await mkUser(p.id)
    const { post } = await publicFeed.createPublicPost(p.id, eu, {
      boardSlug: 'feature-requests',
      title: 'Has comments',
      body: 'discuss',
    })
    const c = await publicFeed.addPublicComment(p.id, post!.id, eu, { body: 'a normal comment' })
    expect((await commentSvc.listComments(p.id, post!.id)).length).toBe(1)

    await moderation.moderateComment(ctx, p.id, c!.id, 'hide')
    expect((await commentSvc.listComments(p.id, post!.id)).length).toBe(0)
    // still reachable for moderators with includeHidden
    expect((await commentSvc.listComments(p.id, post!.id, { includeHidden: true })).length).toBe(1)
  })
})

describe('AI depth at submit time (Phase 20)', () => {
  test('a public post is sentiment-scored and auto-tagged on submit', async () => {
    const p = await newProject('aidepth')
    // a tag the text will match
    await tags.createTag(ctx, p.id, { name: 'mobile', color: '#000' })
    const eu = await mkUser(p.id)
    const { post } = await publicFeed.createPublicPost(p.id, eu, {
      boardSlug: 'feature-requests',
      title: 'The mobile app is broken and crashes',
      body: 'It is terrible and useless, crashes constantly.',
    })
    // sentiment scored deterministically at create time
    expect(post!.sentimentLabel).toBe('negative')
    // auto-tagged because "mobile" appears in the text
    const applied = await tags.listPostTags(ctx, p.id, post!.id)
    expect(applied.some((t) => t.name === 'mobile')).toBe(true)
  })
})

describe('audit log (Phase 17)', () => {
  test('mutations record entries; admins read them; non-admins cannot', async () => {
    await newProject('audited') // records `project.created`
    const log = await audit.listAuditLog(ctx)
    expect(log.some((e) => e.action === 'project.created')).toBe(true)

    // a plain member may not read the org audit trail
    const memberCtx: AuthContext = { kind: 'session', orgId, role: 'member' }
    await expect(audit.listAuditLog(memberCtx)).rejects.toThrow()
  })
})

describe('insights + analytics (Phase 19)', () => {
  test('linking a quote shows up on the post and in "most evidenced"', async () => {
    const p = await newProject('ins')
    const eu = await mkUser(p.id)
    const { post } = await publicFeed.createPublicPost(p.id, eu, {
      boardSlug: 'feature-requests',
      title: 'Bulk export',
      body: 'we need CSV export',
    })
    await insights.addInsight(ctx, p.id, {
      postId: post!.id,
      quote: 'Without CSV export we cannot adopt this.',
      source: 'sales',
      customerEmail: 'buyer@globex.com',
    })
    const listed = await insights.listInsights(ctx, p.id, { postId: post!.id })
    expect(listed).toHaveLength(1)
    expect(listed[0]!.source).toBe('sales')

    const a = await analytics.getAnalytics(ctx, p.id, { timeframe: 'all' })
    expect(a.mostEvidenced.find((m) => m.id === post!.id)?.insightCount).toBe(1)
  })

  test('analytics aggregates votes, board health and status distribution', async () => {
    const p = await newProject('an')
    const eu1 = await mkUser(p.id)
    const eu2 = await mkUser(p.id)
    const { post } = await publicFeed.createPublicPost(p.id, eu1, {
      boardSlug: 'feature-requests',
      title: 'Dark mode',
      body: '',
    })
    await votes.toggleVote(p.id, post!.id, eu1)
    await votes.toggleVote(p.id, post!.id, eu2)

    const a = await analytics.getAnalytics(ctx, p.id, { timeframe: 'all' })
    expect(a.summary.posts).toBe(1)
    expect(a.summary.votes).toBe(2)
    expect(a.summary.voters).toBe(2)
    // board health rolls posts up under their board
    const feature = a.boardHealth.find((b) => b.name === 'Feature Requests')
    expect(feature?.total).toBe(1)
    // status distribution counts the open post
    expect(a.statusDistribution.find((s) => s.kind === 'open')?.count).toBe(1)

    // CSV export carries the headline metrics
    const csv = await analytics.exportAnalyticsCsv(ctx, p.id, { timeframe: 'all' })
    expect(csv).toContain('Votes,2')
    expect(csv).toContain('Board,Total,Open')
  })
})
