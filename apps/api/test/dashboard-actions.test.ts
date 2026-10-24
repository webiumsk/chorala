import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { AuthContext } from '../../../packages/core/src/context.ts'

const mocks = vi.hoisted(() => ({
  requireAuthContext: vi.fn(),
  createPost: vi.fn(),
  changeStatus: vi.fn(),
  moderatePost: vi.fn(),
  revalidatePath: vi.fn(),
}))

vi.mock('../../dashboard/lib/session', () => ({ requireAuthContext: mocks.requireAuthContext }))
vi.mock('../../dashboard/node_modules/next/cache.js', () => ({
  revalidatePath: mocks.revalidatePath,
}))
vi.mock('../../dashboard/node_modules/next/navigation.js', () => ({ redirect: vi.fn() }))
vi.mock('@chorala/ai', () => ({
  createProvider: () => ({ enabled: false }),
  askFeedback: vi.fn(),
  draftReply: vi.fn(),
  extractFeatureRequests: vi.fn(),
  suggestTags: vi.fn(),
}))
vi.mock('@chorala/core', async () => ({
  assertPermission: (await import('../../../packages/core/src/context.ts')).assertPermission,
  posts: { createPost: mocks.createPost, changeStatus: mocks.changeStatus },
  moderation: { moderatePost: mocks.moderatePost },
  apiKeys: {},
  boards: {},
  changelog: {},
  comments: {},
  insights: {},
  integrations: {},
  members: {},
  projects: {},
  publicFeed: {},
  scoreFields: {},
  segments: {},
  statuses: {},
  surveys: {},
  tags: {},
  votes: {},
}))

import { adminCreatePost, changePostStatus, moderatePost } from '../../dashboard/lib/actions.ts'

const owner: AuthContext = {
  kind: 'session',
  orgId: 'org_synthetic',
  userId: 'user_synthetic',
  memberId: 'mem_synthetic',
  role: 'owner',
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.requireAuthContext.mockResolvedValue(owner)
  mocks.createPost.mockResolvedValue({ id: 'post_synthetic' })
})

describe('dashboard server action write authorization', () => {
  test('an administrator resolves authentication once and reaches the post writer', async () => {
    const form = new FormData()
    form.set('projectId', 'proj_synthetic')
    form.set('boardId', 'board_synthetic')
    form.set('title', 'Synthetic feature request')
    form.set('body', 'Synthetic report body')

    await adminCreatePost(form)

    expect(mocks.requireAuthContext).toHaveBeenCalledTimes(1)
    expect(mocks.createPost).toHaveBeenCalledExactlyOnceWith(owner, 'proj_synthetic', {
      boardId: 'board_synthetic',
      title: 'Synthetic feature request',
      body: 'Synthetic report body',
    })
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/proj_synthetic/posts')
  })

  test('a read-only member is refused before any domain mutation or revalidation', async () => {
    mocks.requireAuthContext.mockResolvedValue({ ...owner, role: 'member' })

    await expect(
      changePostStatus('proj_synthetic', 'post_synthetic', 'status_synthetic'),
    ).rejects.toMatchObject({ status: 403 })

    expect(mocks.requireAuthContext).toHaveBeenCalledTimes(1)
    expect(mocks.changeStatus).not.toHaveBeenCalled()
    expect(mocks.revalidatePath).not.toHaveBeenCalled()
  })

  test('moderators retain the separately authorized moderation workflow', async () => {
    const moderator = { ...owner, role: 'moderator' as const }
    mocks.requireAuthContext.mockResolvedValue(moderator)

    await moderatePost('proj_synthetic', 'post_synthetic', 'hide')

    expect(mocks.requireAuthContext).toHaveBeenCalledTimes(1)
    expect(mocks.moderatePost).toHaveBeenCalledExactlyOnceWith(
      moderator,
      'proj_synthetic',
      'post_synthetic',
      'hide',
    )
    expect(mocks.revalidatePath).toHaveBeenCalledWith('/admin/proj_synthetic/moderation')
  })
})
