'use server'

import {
  askFeedback,
  createProvider,
  draftReply,
  extractFeatureRequests,
  suggestTags,
} from '@chorala/ai'
import {
  apiKeys,
  assertPermission,
  boards,
  changelog,
  comments,
  insights,
  integrations,
  members,
  moderation,
  posts,
  projects,
  publicFeed,
  scoreFields,
  segments,
  statuses,
  surveys,
  tags,
  votes,
} from '@chorala/core'
import type { CreateInsightInput, CreateSurveyInput, SegmentDefinition } from '@chorala/types'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { parseChangelogForm } from './changelog-form'
import { requireAuthContext } from './session'

// --- Portal (public, no admin auth) ---
export async function subscribeToChangelog(projectId: string, email: string) {
  await publicFeed.subscribeChangelog(projectId, email)
}

const adminPath = (projectId: string) => `/admin/${projectId}`

/** Server actions bypass the HTTP API, so enforce the same staff write policy here. */
async function requireWriteContext() {
  const ctx = await requireAuthContext()
  assertPermission(ctx, 'write')
  return ctx
}

// --- Posts / triage ---
export async function changePostStatus(projectId: string, postId: string, statusId: string | null) {
  const ctx = await requireWriteContext()
  await posts.changeStatus(ctx, projectId, postId, statusId)
  revalidatePath(adminPath(projectId), 'layout')
}

export async function togglePin(projectId: string, postId: string, pinned: boolean) {
  const ctx = await requireWriteContext()
  await posts.setPinned(ctx, projectId, postId, pinned)
  revalidatePath(adminPath(projectId), 'layout')
}

export async function mergePost(projectId: string, sourceId: string, targetId: string) {
  const ctx = await requireWriteContext()
  await posts.mergePost(ctx, projectId, sourceId, targetId)
  revalidatePath(adminPath(projectId), 'layout')
}

export async function addComment(
  projectId: string,
  postId: string,
  body: string,
  isInternal: boolean,
) {
  const ctx = await requireWriteContext()
  await comments.createAdminComment(ctx, projectId, postId, { body, isInternal })
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

export async function setPostTags(projectId: string, postId: string, tagIds: string[]) {
  const ctx = await requireWriteContext()
  await tags.setPostTags(ctx, projectId, postId, tagIds)
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

export async function createTag(projectId: string, name: string, color: string) {
  const ctx = await requireWriteContext()
  await tags.createTag(ctx, projectId, { name, color })
  revalidatePath(adminPath(projectId), 'layout')
}

// --- Triage (Phase 12) ---
export async function setAssignee(projectId: string, postId: string, memberId: string | null) {
  const ctx = await requireWriteContext()
  await posts.updatePost(ctx, projectId, postId, { assigneeMemberId: memberId })
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

export async function setPostScoreFields(
  projectId: string,
  postId: string,
  fields: Record<string, number>,
) {
  const ctx = await requireWriteContext()
  await posts.updatePost(ctx, projectId, postId, { fields })
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

export async function voteForUser(projectId: string, postId: string, email: string) {
  const ctx = await requireWriteContext()
  await votes.voteForUser(ctx, projectId, postId, { email })
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

export async function createScoreField(
  projectId: string,
  input: { key: string; label: string; weight: number },
) {
  const ctx = await requireWriteContext()
  await scoreFields.createScoreField(ctx, projectId, input)
  revalidatePath(adminPath(projectId), 'layout')
}

export async function deleteScoreField(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await scoreFields.deleteScoreField(ctx, projectId, id)
  revalidatePath(adminPath(projectId), 'layout')
}

// --- Segments (Phase 13) ---
export async function previewSegment(projectId: string, definition: SegmentDefinition) {
  const ctx = await requireAuthContext()
  return segments.previewSegment(ctx, projectId, definition)
}

export async function createSegment(
  projectId: string,
  name: string,
  definition: SegmentDefinition,
) {
  const ctx = await requireWriteContext()
  await segments.createSegment(ctx, projectId, { name, definition })
  revalidatePath(adminPath(projectId), 'layout')
}

export async function deleteSegment(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await segments.deleteSegment(ctx, projectId, id)
  revalidatePath(adminPath(projectId), 'layout')
}

// --- Autopilot / AI capture (Phase 14) ---
const aiProvider = createProvider()

export async function ingestFeedback(projectId: string, source: string, text: string) {
  const ctx = await requireWriteContext()
  const items = await extractFeatureRequests(aiProvider, text)
  for (const item of items) {
    await posts.createReviewPost(ctx, projectId, { ...item, source: { type: source } })
  }
  revalidatePath(`${adminPath(projectId)}/autopilot`)
  return { created: items.length, aiEnabled: aiProvider.enabled }
}

export async function askFeedbackAction(projectId: string, question: string) {
  const ctx = await requireAuthContext()
  await projects.getProject(ctx, projectId)
  return askFeedback(aiProvider, projectId, question)
}

export async function approvePost(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await posts.approvePost(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}`, 'layout')
}

export async function dismissPost(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await posts.dismissPost(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}/autopilot`)
}

// --- AI depth / Autopilot v2 (Phase 20) ---
export async function draftReplyAction(projectId: string, postId: string): Promise<string> {
  const ctx = await requireAuthContext()
  await posts.getPost(ctx, projectId, postId) // scope check
  return draftReply(createProvider(), postId)
}
export async function suggestTagsAction(projectId: string, postId: string) {
  const ctx = await requireWriteContext()
  const post = await posts.getPost(ctx, projectId, postId)
  const suggested = await suggestTags(createProvider(), projectId, `${post.title}\n${post.body}`)
  const applied = await tags.addPostTags(
    projectId,
    postId,
    suggested.map((t) => t.id),
  )
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
  return { suggested, applied }
}

// --- Insights / evidence linking (Phase 19) ---
export async function addInsight(projectId: string, input: CreateInsightInput) {
  const ctx = await requireWriteContext()
  await insights.addInsight(ctx, projectId, input)
  revalidatePath(`${adminPath(projectId)}/posts/${input.postId}`)
}
export async function removeInsight(projectId: string, postId: string, id: string) {
  const ctx = await requireWriteContext()
  await insights.removeInsight(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
}

// --- Moderation (Phase 17) ---
export async function moderatePost(
  projectId: string,
  id: string,
  action: 'hide' | 'unhide' | 'approve',
) {
  const ctx = await requireAuthContext()
  await moderation.moderatePost(ctx, projectId, id, action)
  revalidatePath(`${adminPath(projectId)}/moderation`)
}
export async function moderateComment(
  projectId: string,
  id: string,
  action: 'hide' | 'unhide' | 'approve',
) {
  const ctx = await requireAuthContext()
  await moderation.moderateComment(ctx, projectId, id, action)
  revalidatePath(`${adminPath(projectId)}/moderation`)
}

// --- Surveys (Phase 16) ---
export async function createSurvey(projectId: string, input: CreateSurveyInput) {
  const ctx = await requireWriteContext()
  await surveys.createSurvey(ctx, projectId, input)
  revalidatePath(`${adminPath(projectId)}/surveys`)
}

export async function toggleSurvey(projectId: string, id: string, isActive: boolean) {
  const ctx = await requireWriteContext()
  await surveys.updateSurvey(ctx, projectId, id, { isActive })
  revalidatePath(`${adminPath(projectId)}/surveys`)
}

export async function deleteSurvey(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await surveys.deleteSurvey(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}/surveys`)
}

export async function adminCreatePost(formData: FormData) {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  await posts.createPost(ctx, projectId, {
    boardId: String(formData.get('boardId')),
    title: String(formData.get('title')),
    body: String(formData.get('body') ?? ''),
  })
  revalidatePath(`${adminPath(projectId)}/posts`)
}

// --- Boards / statuses ---
export async function createBoard(formData: FormData) {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  await boards.createBoard(ctx, projectId, {
    name: String(formData.get('name')),
    slug: String(formData.get('slug')),
    kind: 'feature',
    isPrivate: false,
  })
  revalidatePath(adminPath(projectId), 'layout')
}

// --- Changelog ---
export async function saveChangelog(formData: FormData) {
  const ctx = await requireWriteContext()
  const parsed = parseChangelogForm(formData)
  if (parsed.id !== null) {
    await changelog.updateChangelog(ctx, parsed.projectId, parsed.id, parsed.payload)
  } else {
    await changelog.createChangelog(ctx, parsed.projectId, parsed.payload)
  }
  revalidatePath(`${adminPath(parsed.projectId)}/changelog`)
  revalidatePath(`/portal/${parsed.projectId}/changelog`)
}

export async function deleteChangelog(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await changelog.deleteChangelog(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}/changelog`)
  revalidatePath(`/portal/${projectId}/changelog`)
}

// --- Settings ---
export async function updateProjectSettings(formData: FormData) {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  await projects.updateProject(ctx, projectId, {
    name: String(formData.get('name')),
    allowedOrigins: String(formData.get('allowedOrigins') ?? '')
      .split(/[\n,]/)
      .map((s) => s.trim())
      .filter(Boolean),
    widgetSettings: {
      primaryColor: String(formData.get('primaryColor') ?? '#6366f1'),
      theme: String(formData.get('theme') ?? 'light'),
      mode: String(formData.get('mode') ?? 'floating'),
    },
  })
  revalidatePath(`${adminPath(projectId)}/settings`)
}

export async function createProject(formData: FormData) {
  const ctx = await requireWriteContext()
  const project = await projects.createProject(ctx, {
    name: String(formData.get('name')),
    slug: String(formData.get('slug')),
    isPublic: true,
    allowedOrigins: [],
  })
  revalidatePath('/admin', 'layout')
  if (project) redirect(`/admin/${project.id}/posts`)
}

// --- Members ---
export async function inviteMember(formData: FormData) {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  await members.inviteMember(ctx, {
    email: String(formData.get('email')),
    role: (String(formData.get('role')) || 'member') as 'owner' | 'admin' | 'member',
  })
  revalidatePath(`${adminPath(projectId)}/members`)
}

// --- API keys ---
export async function createApiKey(formData: FormData): Promise<string> {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  const created = await apiKeys.createApiKey(ctx, projectId, {
    name: String(formData.get('name')),
    scopes: ['read', 'write'],
  })
  revalidatePath(`${adminPath(projectId)}/keys`)
  return created.key
}

export async function revokeApiKey(projectId: string, id: string) {
  const ctx = await requireWriteContext()
  await apiKeys.revokeApiKey(ctx, projectId, id)
  revalidatePath(`${adminPath(projectId)}/keys`)
}

// --- GitHub integration ---
export async function connectGithub(formData: FormData) {
  const ctx = await requireWriteContext()
  const projectId = String(formData.get('projectId'))
  await integrations.setGithubIntegration(ctx, projectId, {
    repo: String(formData.get('repo')).trim(),
    token: String(formData.get('token') ?? '').trim() || undefined,
    autoCreate: (String(formData.get('autoCreate') ?? 'off') || 'off') as 'off' | 'bug' | 'all',
  })
  revalidatePath(`${adminPath(projectId)}/settings`)
}

export async function disconnectGithub(projectId: string) {
  const ctx = await requireWriteContext()
  await integrations.removeGithubIntegration(ctx, projectId)
  revalidatePath(`${adminPath(projectId)}/settings`)
}

export async function connectDiscord(projectId: string, webhookUrl: string) {
  const ctx = await requireWriteContext()
  await integrations.setDiscordIntegration(ctx, projectId, webhookUrl.trim())
  revalidatePath(`${adminPath(projectId)}/settings`)
}

export async function connectSegment(projectId: string) {
  const ctx = await requireWriteContext()
  const res = await integrations.setSegmentIntegration(ctx, projectId)
  revalidatePath(`${adminPath(projectId)}/settings`)
  return res // { secret, url } — shown once
}

export async function disconnectIntegration(projectId: string, type: 'discord' | 'segment') {
  const ctx = await requireWriteContext()
  await integrations.removeIntegration(ctx, projectId, type)
  revalidatePath(`${adminPath(projectId)}/settings`)
}

export async function createGithubIssue(projectId: string, postId: string) {
  const ctx = await requireWriteContext()
  const link = await integrations.createGithubIssue(ctx, projectId, postId)
  revalidatePath(`${adminPath(projectId)}/posts/${postId}`)
  return link
}

// --- Statuses (for reorder/roadmap toggle) ---
export async function toggleRoadmap(projectId: string, statusId: string, show: boolean) {
  const ctx = await requireWriteContext()
  await statuses.updateStatus(ctx, projectId, statusId, { showOnRoadmap: show })
  revalidatePath(adminPath(projectId), 'layout')
}
