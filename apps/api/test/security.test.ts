import { randomUUID } from 'node:crypto'
import { env } from '@chorala/config'
import {
  type AuthContext,
  apiKeys,
  boards,
  changelog,
  comments,
  moderation,
  posts,
  projects,
  publicFeed,
  segments,
  statuses,
  surveys,
  tags,
  votes,
} from '@chorala/core'
import {
  and,
  client,
  comments as commentsTable,
  db,
  endUsers,
  eq,
  apiKeys as keysTable,
  members,
  newId,
  organizations,
  posts as postsTable,
  users,
  votes as votesTable,
} from '@chorala/db'
import { MAX_ATTACHMENT_DATA_URL_LENGTH } from '@chorala/types'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { createApp } from '../src/app.ts'
import { auth } from '../src/auth.ts'
import { redis } from '../src/lib/redis.ts'

const app = createApp()
const workspaces: { orgId: string; userId: string }[] = []
let owner: AuthContext
let otherOwner: AuthContext
let projectId: string
let foreignProjectId: string
let boardId: string
let postId: string
let privatePostId: string
let foreignPostId: string
let endUserId: string
let foreignUserId: string
let secret: string
let publicKey: string
let readHeaders: Record<string, string>
let writeHeaders: Record<string, string>
const withheldPostIds: string[] = []

async function workspace(): Promise<AuthContext> {
  const orgId = newId('organization')
  const userId = newId('user')
  const memberId = newId('member')
  const slug = `security-${randomUUID().slice(0, 8)}`
  await db.insert(organizations).values({ id: orgId, slug, name: 'Disposable security workspace' })
  await db
    .insert(users)
    .values({ id: userId, email: `${slug}@example.test`, name: 'Test operator' })
  await db.insert(members).values({ id: memberId, orgId, userId, role: 'owner' })
  workspaces.push({ orgId, userId })
  return { kind: 'session', orgId, userId, memberId, role: 'owner' }
}

beforeAll(async () => {
  owner = await workspace()
  otherOwner = await workspace()
  const project = await projects.createProject(owner, {
    name: 'Product A',
    slug: 'a',
    isPublic: true,
    allowedOrigins: [],
  })
  const foreign = await projects.createProject(otherOwner, {
    name: 'Product B',
    slug: 'b',
    isPublic: true,
    allowedOrigins: [],
  })
  if (!project || !foreign) throw new Error('Disposable project creation failed')
  projectId = project.id
  foreignProjectId = foreign.id
  publicKey = project.publicKey
  secret = project.endUserJwtSecret
  boardId = (await boards.listBoards(owner, projectId))[0]!.id
  const foreignBoardId = (await boards.listBoards(otherOwner, foreignProjectId))[0]!.id
  const privateBoard = await boards.createBoard(owner, projectId, {
    name: 'Private',
    slug: 'private',
    kind: 'bug',
    isPrivate: true,
  })
  if (!privateBoard) throw new Error('Private board missing')
  const planned = (await statuses.listStatuses(owner, projectId)).find(
    (status) => status.kind === 'planned',
  )!
  const publicPost = await posts.createPost(owner, projectId, {
    boardId,
    title: 'Public idea',
    body: '',
  })
  postId = publicPost.id
  await posts.changeStatus(owner, projectId, postId, planned.id)
  for (const kind of ['private', 'hidden', 'pending', 'dismissed']) {
    const post = await posts.createPost(owner, projectId, {
      boardId: kind === 'private' ? privateBoard.id : boardId,
      title: `${kind} report`,
      body: 'Not public',
    })
    await posts.changeStatus(owner, projectId, post.id, planned.id)
    if (kind === 'private') privatePostId = post.id
    if (kind === 'hidden')
      await db.update(postsTable).set({ hiddenAt: new Date() }).where(eq(postsTable.id, post.id))
    if (kind === 'pending' || kind === 'dismissed')
      await db.update(postsTable).set({ reviewStatus: kind }).where(eq(postsTable.id, post.id))
    withheldPostIds.push(post.id)
  }
  foreignPostId = (
    await posts.createPost(otherOwner, foreignProjectId, {
      boardId: foreignBoardId,
      title: 'Foreign idea',
      body: '',
    })
  ).id
  endUserId = newId('endUser')
  foreignUserId = newId('endUser')
  await db.insert(endUsers).values([
    { id: endUserId, projectId, isAnonymous: true },
    { id: foreignUserId, projectId: foreignProjectId, isAnonymous: true },
  ])
  const readKey = await apiKeys.createApiKey(owner, projectId, { name: 'Reader', scopes: ['read'] })
  const writeKey = await apiKeys.createApiKey(owner, projectId, {
    name: 'Writer',
    scopes: ['read', 'write'],
  })
  readHeaders = { authorization: `Bearer ${readKey.key}`, 'content-type': 'application/json' }
  writeHeaders = { authorization: `Bearer ${writeKey.key}`, 'content-type': 'application/json' }
})

afterAll(async () => {
  for (const workspace of workspaces) {
    await db.delete(organizations).where(eq(organizations.id, workspace.orgId))
    await db.delete(users).where(eq(users.id, workspace.userId))
  }
  await redis.quit()
  await client.end()
})

describe('project permissions', () => {
  test('a reader can read but cannot mutate or create a more privileged key', async () => {
    const beforeKeys = await db
      .select({ id: keysTable.id })
      .from(keysTable)
      .where(eq(keysTable.projectId, projectId))
    expect(
      (await app.request(`/api/v1/projects/${projectId}/posts`, { headers: readHeaders })).status,
    ).toBe(200)
    const preview = await app.request(`/api/v1/projects/${projectId}/segments/preview`, {
      method: 'POST',
      headers: readHeaders,
      body: JSON.stringify({ match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] }),
    })
    expect(preview.status).toBe(200)
    const create = await app.request(`/api/v1/projects/${projectId}/posts`, {
      method: 'POST',
      headers: readHeaders,
      body: JSON.stringify({ boardId, title: 'Forbidden reader write', body: '' }),
    })
    expect(create.status).toBe(403)
    for (const headers of [readHeaders, writeHeaders]) {
      const key = await app.request(`/api/v1/projects/${projectId}/keys`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'Escalation', scopes: ['write'] }),
      })
      expect(key.status).toBe(403)
    }
    expect(
      await db
        .select({ id: keysTable.id })
        .from(keysTable)
        .where(eq(keysTable.projectId, projectId)),
    ).toHaveLength(beforeKeys.length)
    expect(
      await db
        .select({ id: postsTable.id })
        .from(postsTable)
        .where(
          and(eq(postsTable.projectId, projectId), eq(postsTable.title, 'Forbidden reader write')),
        ),
    ).toHaveLength(0)
  })

  test('project-scoped keys cannot read organization-wide membership or audit events', async () => {
    for (const path of ['/org', '/org/members', '/org/audit-log']) {
      expect((await app.request(`/api/v1${path}`, { headers: readHeaders })).status).toBe(403)
    }
  })

  test('cookie-authenticated writes require an explicitly trusted Origin', async () => {
    const now = new Date()
    const getSession = vi.spyOn(auth.api, 'getSession').mockResolvedValue({
      user: {
        id: owner.userId!,
        name: 'Synthetic operator',
        email: 'operator@example.test',
        emailVerified: true,
        image: null,
        createdAt: now,
        updatedAt: now,
      },
      session: {
        id: 'synthetic-session',
        token: 'synthetic-session-token',
        userId: owner.userId!,
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
        updatedAt: now,
        ipAddress: null,
        userAgent: null,
      },
    })
    try {
      const base = `/api/v1/projects/${projectId}/posts/${postId}/comments`
      for (const origin of [undefined, 'https://untrusted.example.test']) {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (origin) headers.origin = origin
        expect(
          (
            await app.request(base, {
              method: 'POST',
              headers,
              body: JSON.stringify({ body: 'Rejected cross-origin comment' }),
            })
          ).status,
        ).toBe(403)
      }
      const permitted = await app.request(base, {
        method: 'POST',
        headers: {
          origin: new URL(env.CHORALA_PUBLIC_URL).origin,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ body: 'Permitted same-origin comment' }),
      })
      expect(permitted.status).toBe(201)
    } finally {
      getSession.mockRestore()
    }
  })

  test('project lists and details do not disclose the SSO signing secret to keys or read-only staff', async () => {
    const list = await app.request('/api/v1/projects', { headers: readHeaders })
    const detail = await app.request(`/api/v1/projects/${projectId}`, { headers: readHeaders })
    expect(await list.text()).not.toContain(secret)
    expect(await detail.text()).not.toContain(secret)
    for (const role of ['member', 'moderator'] as const) {
      expect(
        (await projects.getProject({ ...owner, role }, projectId)).endUserJwtSecret,
      ).toBeUndefined()
      expect(
        (await projects.listProjects({ ...owner, role })).every(
          (row) => row.endUserJwtSecret === undefined,
        ),
      ).toBe(true)
    }
    expect((await projects.getProject(owner, projectId)).endUserJwtSecret).toBe(secret)
  })

  test('read-only staff and keys cannot bypass permissions through domain services', async () => {
    for (const ctx of [
      { ...owner, role: 'member' as const },
      { ...owner, role: 'moderator' as const },
      { kind: 'apikey' as const, orgId: owner.orgId, projectId, scopes: ['read'] },
    ]) {
      await expect(
        posts.createPost(ctx, projectId, { boardId, title: 'Domain write denied', body: '' }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        comments.createAdminComment(ctx, projectId, postId, { body: 'Denied staff comment' }),
      ).rejects.toMatchObject({ status: 403 })
      await expect(
        apiKeys.createApiKey(ctx, projectId, { name: 'Denied key', scopes: ['write'] }),
      ).rejects.toMatchObject({ status: 403 })
    }
  })

  test('foreign-project staff comments cannot be read, changed or deleted', async () => {
    const internal = await comments.createAdminComment(
      otherOwner,
      foreignProjectId,
      foreignPostId,
      { body: 'Private staff discussion', isInternal: true },
    )
    if (!internal) throw new Error('Internal comment missing')
    const base = `/api/v1/projects/${foreignProjectId}/posts/${foreignPostId}/comments`
    expect((await app.request(base, { headers: writeHeaders })).status).toBe(404)
    expect(
      (
        await app.request(base, {
          method: 'POST',
          headers: writeHeaders,
          body: JSON.stringify({ body: 'Cross-project injection' }),
        })
      ).status,
    ).toBe(404)
    expect(
      (await app.request(`${base}/${internal.id}`, { method: 'DELETE', headers: writeHeaders }))
        .status,
    ).toBe(404)
    await expect(
      comments.listAdminComments(owner, foreignProjectId, foreignPostId),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      comments.createAdminComment(owner, foreignProjectId, foreignPostId, {
        body: 'Cross-organization injection',
      }),
    ).rejects.toMatchObject({ status: 404 })
    expect(
      await comments.listAdminComments(otherOwner, foreignProjectId, foreignPostId),
    ).toHaveLength(1)
  })

  test('moderation authority never grants access to another organization', async () => {
    await expect(moderation.listModerationQueue(owner, foreignProjectId)).rejects.toMatchObject({
      status: 404,
    })
    await expect(
      moderation.moderatePost(owner, foreignProjectId, foreignPostId, 'hide'),
    ).rejects.toMatchObject({ status: 404 })
    const response = await app.request(
      `/api/v1/projects/${foreignProjectId}/moderation/posts/${foreignPostId}`,
      { method: 'POST', headers: writeHeaders, body: JSON.stringify({ action: 'hide' }) },
    )
    expect(response.status).toBe(404)
    const [row] = await db
      .select({ hiddenAt: postsTable.hiddenAt })
      .from(postsTable)
      .where(eq(postsTable.id, foreignPostId))
    expect(row?.hiddenAt).toBeNull()
  })

  test('post tags are scoped by both post and project', async () => {
    const foreignTag = await tags.createTag(otherOwner, foreignProjectId, {
      name: 'Private tag',
      color: '#123456',
    })
    await tags.setPostTags(otherOwner, foreignProjectId, foreignPostId, [foreignTag!.id])
    await expect(tags.listPostTags(owner, projectId, foreignPostId)).rejects.toMatchObject({
      status: 404,
    })
  })

  test('foreign status, assignee and audience references are rejected before mutation', async () => {
    const foreignStatus = (await statuses.listStatuses(otherOwner, foreignProjectId))[0]!
    await expect(
      posts.createPost(owner, projectId, {
        boardId,
        title: 'Invalid foreign status',
        body: '',
        statusId: foreignStatus.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
    for (const input of [
      { statusId: foreignStatus.id },
      { assigneeMemberId: otherOwner.memberId },
    ]) {
      const response = await app.request(`/api/v1/projects/${projectId}/posts/${postId}`, {
        method: 'PATCH',
        headers: writeHeaders,
        body: JSON.stringify({
          ...input,
          title: 'Unauthorized reference must not change this title',
        }),
      })
      expect(response.status).toBe(404)
    }
    expect((await posts.getPost(owner, projectId, postId)).title).toBe('Public idea')
    const foreignSegment = await segments.createSegment(otherOwner, foreignProjectId, {
      name: 'Foreign audience',
      definition: { match: 'all', rules: [{ field: 'plan', op: 'eq', value: 'pro' }] },
    })
    await expect(
      changelog.createChangelog(owner, projectId, {
        title: 'Invalid linked post',
        body: '',
        status: 'draft',
        labels: [],
        linkedPostIds: [foreignPostId],
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      changelog.createChangelog(owner, projectId, {
        title: 'Invalid audience',
        body: '',
        status: 'draft',
        labels: [],
        linkedPostIds: [],
        segmentId: foreignSegment!.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
    await expect(
      surveys.createSurvey(owner, projectId, {
        name: 'Invalid audience survey',
        type: 'nps',
        question: 'Question?',
        config: {},
        isActive: true,
        segmentId: foreignSegment!.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })
})

describe('public visibility is identical for discovery and interaction', () => {
  test('roadmap and details exclude private boards, hidden reports and AI review drafts', async () => {
    const publicHeaders = { 'x-chorala-key': publicKey }
    const roadmap = (await (
      await app.request('/api/v1/public/roadmap', { headers: publicHeaders })
    ).json()) as { columns: { posts: { id: string }[] }[] }
    const ids = roadmap.columns.flatMap((column) => column.posts.map((post) => post.id))
    expect(ids).toContain(postId)
    for (const id of withheldPostIds) {
      expect(ids).not.toContain(id)
      expect(
        (await app.request(`/api/v1/public/posts/${id}`, { headers: publicHeaders })).status,
      ).toBe(404)
      for (const method of ['POST', 'DELETE']) {
        expect(
          (await app.request(`/api/v1/public/posts/${id}/vote`, { method, headers: publicHeaders }))
            .status,
        ).toBe(404)
      }
      expect(
        (
          await app.request(`/api/v1/public/posts/${id}/comments`, {
            method: 'POST',
            headers: { ...publicHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ body: 'Not authorized' }),
          })
        ).status,
      ).toBe(404)
      expect(
        await db.select({ id: votesTable.id }).from(votesTable).where(eq(votesTable.postId, id)),
      ).toHaveLength(0)
      expect(
        await db
          .select({ id: commentsTable.id })
          .from(commentsTable)
          .where(eq(commentsTable.postId, id)),
      ).toHaveLength(0)
    }
  })

  test('a public merge alias cannot cast a vote into a private canonical post', async () => {
    const alias = await posts.createPost(owner, projectId, {
      boardId,
      title: 'Public alias',
      body: '',
    })
    await db
      .update(postsTable)
      .set({ mergedIntoPostId: privatePostId })
      .where(eq(postsTable.id, alias.id))
    await expect(votes.setVote(projectId, alias.id, endUserId, true)).rejects.toMatchObject({
      status: 404,
    })
    expect(
      await db
        .select({ id: votesTable.id })
        .from(votesTable)
        .where(eq(votesTable.postId, privatePostId)),
    ).toHaveLength(0)
  })

  test('identities and comment parent references cannot cross project or private-note boundaries', async () => {
    await expect(votes.setVote(projectId, postId, foreignUserId, true)).rejects.toMatchObject({
      status: 404,
    })
    const internal = await comments.createAdminComment(owner, projectId, postId, {
      body: 'Staff only',
      isInternal: true,
    })
    await expect(
      publicFeed.addPublicComment(projectId, postId, endUserId, {
        body: 'Reply to private note',
        parentCommentId: internal!.id,
      }),
    ).rejects.toMatchObject({ status: 404 })
  })

  test('authorized staff can still record a customer vote on a private board', async () => {
    expect(
      (
        await votes.voteForUser(owner, projectId, privatePostId, {
          email: 'synthetic-customer@example.test',
        })
      ).voted,
    ).toBe(true)
  })
})

test('oversized API requests are rejected before authentication or parsing', async () => {
  const res = await app.request('/api/v1/public/posts', {
    method: 'POST',
    headers: { 'content-length': String(MAX_ATTACHMENT_DATA_URL_LENGTH + 4097) },
    body: '{}',
  })
  expect(res.status).toBe(413)
  expect(await res.json()).toEqual({
    error: { code: 'payload_too_large', message: 'Request body is too large' },
  })
})

test('chunked bodies without Content-Length are bounded as well', async () => {
  const chunk = new Uint8Array(64 * 1024)
  const maxChunks = Math.ceil((MAX_ATTACHMENT_DATA_URL_LENGTH + 4097) / chunk.byteLength)
  let sent = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent++ < maxChunks) controller.enqueue(chunk)
      else controller.close()
    },
  })
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', body: stream, duplex: 'half' }
  const res = await app.request(new Request('http://localhost/api/v1/public/posts', init))
  expect(res.status).toBe(413)
  expect((await res.json()) as { error: { code: string } }).toEqual({
    error: { code: 'payload_too_large', message: 'Request body is too large' },
  })
})
