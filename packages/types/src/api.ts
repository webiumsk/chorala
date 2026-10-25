import { z } from 'zod'
import {
  boardKind,
  changelogStatus,
  insightSource,
  integrationType,
  memberRole,
  paginationQuery,
  postSort,
  prefixedId,
  segmentDefinition,
  statusKind,
  surveyType,
  webhookEvent,
} from './common.ts'
import {
  attachment,
  comment,
  company,
  endUser,
  post,
  postTranslation,
  segment,
  status,
} from './entities.ts'

// =====================================================================
// Public / widget API (SPEC §8.2)
// =====================================================================

export const publicBoardsQuery = paginationQuery.extend({
  boardSlug: z.string().optional(),
  statusId: z.string().optional(),
  tagId: z.string().optional(),
  sort: postSort.default('top'),
  locale: z.string().optional(),
  search: z.string().optional(),
})
export type PublicBoardsQuery = z.infer<typeof publicBoardsQuery>

export const createPostInput = z.object({
  boardSlug: z.string().min(1),
  title: z.string().min(2).max(300),
  body: z.string().max(20_000).default(''),
  locale: z.string().optional(),
  // Structured submission context (Sentry/Canny style). `appVersion` is first-class and
  // filterable; `metadata` is a free-form map (userAgent, locale, platform, screen, …).
  appVersion: z.string().max(120).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
  // Screenshots/files uploaded via POST /public/attachments, linked to the post on create.
  attachmentIds: z.array(z.string()).max(10).optional(),
})
export type CreatePostInput = z.infer<typeof createPostInput>

/** Hard ceilings bound allocation before JSON/base64 decoding and image processing. */
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
export const MAX_ATTACHMENT_DATA_URL_LENGTH = 4 * Math.ceil(MAX_ATTACHMENT_BYTES / 3) + 128

/** Upload an attachment (currently a bug-report screenshot) as a data URL. */
export const createAttachmentInput = z.object({
  // `data:<mime>;base64,<payload>` — kept small by per-file + per-project byte limits.
  dataUrl: z.string().startsWith('data:').max(MAX_ATTACHMENT_DATA_URL_LENGTH),
  kind: z.enum(['screenshot', 'file']).default('screenshot'),
})
export type CreateAttachmentInput = z.infer<typeof createAttachmentInput>

/** Returned on upload — the id the widget threads into `createPostInput.attachmentIds`. */
export const attachmentRef = attachment.pick({
  id: true,
  kind: true,
  mimeType: true,
  byteSize: true,
  width: true,
  height: true,
})
export type AttachmentRef = z.infer<typeof attachmentRef>

export const createCommentInput = z.object({
  body: z.string().min(1).max(20_000),
  parentCommentId: z.string().optional(),
  isInternal: z.boolean().optional(),
})
export type CreateCommentInput = z.infer<typeof createCommentInput>

/** A post enriched for a localized public view. */
export const localizedPost = post.extend({
  hasVoted: z.boolean().optional(),
  displayLocale: z.string().optional(),
  // The post's status (name/color/kind) so public embedders can badge it. `closed`
  // posts are excluded from the board list, so this never surfaces a closed status there.
  status: status.nullable().optional(),
  // Topic tags (name/color) for chips on the portal/widget.
  tags: z.array(z.object({ name: z.string(), color: z.string() })).optional(),
})
export type LocalizedPost = z.infer<typeof localizedPost>

export const postDetail = z.object({
  post: localizedPost,
  comments: z.array(comment),
  translations: z.array(postTranslation),
})
export type PostDetail = z.infer<typeof postDetail>

export const voteToggleResponse = z.object({
  voted: z.boolean(),
  voteCount: z.number().int(),
})
export type VoteToggleResponse = z.infer<typeof voteToggleResponse>

export const roadmapColumn = z.object({
  status: status,
  posts: z.array(localizedPost),
})
export const roadmapResponse = z.object({ columns: z.array(roadmapColumn) })
export type RoadmapResponse = z.infer<typeof roadmapResponse>

export const changelogSubscribeInput = z.object({ email: z.email() })
export type ChangelogSubscribeInput = z.infer<typeof changelogSubscribeInput>

export const identifyInput = z.object({ jwt: z.string().min(1) })
export type IdentifyInput = z.infer<typeof identifyInput>

export const identifyResponse = z.object({
  endUser: endUser,
  token: z.string(),
})
export type IdentifyResponse = z.infer<typeof identifyResponse>

// =====================================================================
// Admin / management API (SPEC §8.1)
// =====================================================================

export const createProjectInput = z.object({
  name: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'lowercase letters, numbers and hyphens only'),
  isPublic: z.boolean().default(true),
  allowedOrigins: z.array(z.string()).default([]),
})
export type CreateProjectInput = z.infer<typeof createProjectInput>

export const updateProjectInput = createProjectInput.partial().extend({
  customDomain: z.string().nullable().optional(),
  widgetSettings: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateProjectInput = z.infer<typeof updateProjectInput>

export const createBoardInput = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  kind: boardKind.default('feature'),
  isPrivate: z.boolean().default(false),
})
export type CreateBoardInput = z.infer<typeof createBoardInput>
export const updateBoardInput = createBoardInput.partial()
export type UpdateBoardInput = z.infer<typeof updateBoardInput>

export const createStatusInput = z.object({
  name: z.string().min(1),
  color: z.string(),
  kind: statusKind,
  showOnRoadmap: z.boolean().default(false),
  position: z.number().int().optional(),
})
export type CreateStatusInput = z.infer<typeof createStatusInput>
export const updateStatusInput = createStatusInput.partial()
export type UpdateStatusInput = z.infer<typeof updateStatusInput>

export const adminCreatePostInput = z.object({
  boardId: z.string().min(1),
  title: z.string().min(2).max(300),
  body: z.string().max(20_000).default(''),
  statusId: z.string().optional(),
  locale: z.string().optional(),
})
export type AdminCreatePostInput = z.infer<typeof adminCreatePostInput>

export const updatePostInput = z.object({
  title: z.string().min(2).max(300).optional(),
  body: z.string().max(20_000).optional(),
  statusId: z.string().nullable().optional(),
  boardId: z.string().optional(),
  isPinned: z.boolean().optional(),
  eta: z.string().nullable().optional(),
  // Triage (Phase 12): assign an owner and set custom numeric scoring fields (key→number).
  assigneeMemberId: z.string().nullable().optional(),
  fields: z.record(z.string(), z.number()).optional(),
})
export type UpdatePostInput = z.infer<typeof updatePostInput>

/** Admin casts a vote on behalf of a user (sales/support logging a request). */
export const voteForInput = z.object({
  email: z.email().optional(),
  externalId: z.string().optional(),
  name: z.string().optional(),
})
export type VoteForInput = z.infer<typeof voteForInput>

export const changePostStatusInput = z.object({ statusId: z.string().nullable() })
export const mergePostInput = z.object({ targetPostId: z.string().min(1) })
export const tagPostInput = z.object({ tagIds: z.array(z.string()) })

export const createTagInput = z.object({ name: z.string().min(1), color: z.string() })
export type CreateTagInput = z.infer<typeof createTagInput>

export const createChangelogInput = z.object({
  title: z.string().min(1),
  body: z.string(),
  status: changelogStatus.default('draft'),
  labels: z.array(z.string()).default([]),
  linkedPostIds: z.array(z.string()).default([]),
  // Target a saved segment — only matching end-users are notified (null = everyone).
  segmentId: z.string().nullable().optional(),
})
export type CreateChangelogInput = z.infer<typeof createChangelogInput>
export const updateChangelogInput = createChangelogInput.partial()
export type UpdateChangelogInput = z.infer<typeof updateChangelogInput>

// --- Segments (Phase 13) ---
export const createSegmentInput = z.object({
  name: z.string().min(1),
  definition: segmentDefinition,
})
export type CreateSegmentInput = z.infer<typeof createSegmentInput>
export const updateSegmentInput = createSegmentInput.partial()
export type UpdateSegmentInput = z.infer<typeof updateSegmentInput>

/** A segment plus how many end-users currently match it. */
export const segmentWithCount = segment.extend({ matchCount: z.number().int() })
export type SegmentWithCount = z.infer<typeof segmentWithCount>

export const createWebhookInput = z.object({
  url: z.url(),
  events: z.array(webhookEvent).min(1),
  isActive: z.boolean().default(true),
})
export type CreateWebhookInput = z.infer<typeof createWebhookInput>

export const createApiKeyInput = z.object({
  name: z.string().min(1),
  scopes: z.array(z.string()).default(['read']),
})
export type CreateApiKeyInput = z.infer<typeof createApiKeyInput>

/** Returned exactly once on creation — the only time the raw key is visible. */
export const createApiKeyResponse = z.object({
  id: z.string(),
  name: z.string(),
  key: z.string(),
  prefix: z.string(),
})
export type CreateApiKeyResponse = z.infer<typeof createApiKeyResponse>

export const createIntegrationInput = z.object({
  type: integrationType,
  config: z.record(z.string(), z.unknown()).default({}),
  secret: z.string().optional(),
})
export type CreateIntegrationInput = z.infer<typeof createIntegrationInput>

export const inviteMemberInput = z.object({
  email: z.email(),
  role: memberRole.default('member'),
})
export type InviteMemberInput = z.infer<typeof inviteMemberInput>

export const updateMemberInput = z.object({ role: memberRole })
export type UpdateMemberInput = z.infer<typeof updateMemberInput>

export const updateOrgSettingsInput = z.object({
  name: z.string().min(1).optional(),
  defaultLocale: z.string().optional(),
  locales: z.array(z.string()).optional(),
  settings: z.record(z.string(), z.unknown()).optional(),
})
export type UpdateOrgSettingsInput = z.infer<typeof updateOrgSettingsInput>

// --- Analytics ---
export const analyticsQuery = z.object({
  boardId: z.string().optional(),
  timeframe: z.enum(['7d', '30d', '90d', 'all']).default('30d'),
})
export type AnalyticsQuery = z.infer<typeof analyticsQuery>

const series = (key: string) => z.array(z.object({ date: z.string(), [key]: z.number().int() }))

export const analyticsResponse = z.object({
  // Headline counters — totals plus this-window vs previous-window for trend arrows.
  summary: z.object({
    posts: z.number().int(),
    votes: z.number().int(),
    comments: z.number().int(),
    voters: z.number().int(),
    newPosts: z.number().int(),
    newVotes: z.number().int(),
    newComments: z.number().int(),
    prevPosts: z.number().int(),
    prevVotes: z.number().int(),
    prevComments: z.number().int(),
  }),
  sentiment: z.object({
    positive: z.number().int(),
    neutral: z.number().int(),
    negative: z.number().int(),
  }),
  voteVelocity: series('votes'),
  postVelocity: series('posts'),
  statusDistribution: z.array(
    z.object({ kind: z.string(), name: z.string(), color: z.string(), count: z.number().int() }),
  ),
  boardHealth: z.array(
    z.object({
      boardId: z.string(),
      name: z.string(),
      total: z.number().int(),
      open: z.number().int(),
      planned: z.number().int(),
      inProgress: z.number().int(),
      complete: z.number().int(),
      votes: z.number().int(),
    }),
  ),
  topTags: z.array(z.object({ name: z.string(), color: z.string(), count: z.number().int() })),
  topPosts: z.array(z.object({ post: post, voteCount: z.number().int() })),
  topByRevenue: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      revenue: z.number().int(),
      voteCount: z.number().int(),
    }),
  ),
  mostEvidenced: z.array(
    z.object({ id: z.string(), title: z.string(), insightCount: z.number().int() }),
  ),
  clusterThemes: z.array(z.object({ label: z.string(), summary: z.string(), count: z.number() })),
})
export type AnalyticsResponse = z.infer<typeof analyticsResponse>

// --- Insights (evidence linking, Phase 19) ---
export const createInsightInput = z.object({
  postId: prefixedId('post'),
  quote: z.string().min(1).max(2000),
  source: insightSource.default('manual'),
  customerEmail: z.string().email().optional(),
  companyId: prefixedId('co').optional(),
})
export type CreateInsightInput = z.infer<typeof createInsightInput>

// --- Companies (B2B revenue intelligence, Phase 11) ---

/** A company plus rollups: how many users it has and the demand it's driving. */
export const companyWithStats = company.extend({
  userCount: z.number().int(),
  postCount: z.number().int(),
})
export type CompanyWithStats = z.infer<typeof companyWithStats>

export const updateCompanyInput = z.object({
  name: z.string().min(1).optional(),
  domain: z.string().nullable().optional(),
  mrr: z.number().int().nonnegative().optional(),
  plan: z.string().nullable().optional(),
})
export type UpdateCompanyInput = z.infer<typeof updateCompanyInput>

/**
 * Admin view of a post: the public shape plus admin-only triage data —
 * `revenueImpact` (Σ MRR of distinct voter companies), the weighted `score`, the assigned
 * owner, and the raw custom `fields`. None of these are exposed on the public payload.
 */
export const reviewStatus = z.enum(['none', 'pending', 'dismissed'])
export type ReviewStatus = z.infer<typeof reviewStatus>

export const adminPostListItem = post.extend({
  revenueImpact: z.number().int(),
  score: z.number(),
  assigneeMemberId: prefixedId('mem').nullable(),
  fields: z.record(z.string(), z.number()),
  reviewStatus: reviewStatus,
  source: z.record(z.string(), z.unknown()),
})
export type AdminPostListItem = z.infer<typeof adminPostListItem>

// --- Autopilot: AI capture (Phase 14) ---
export const feedbackSource = z.enum(['intercom', 'zendesk', 'slack', 'email', 'manual'])
export type FeedbackSource = z.infer<typeof feedbackSource>

/** Ingest a raw support conversation → AI extracts feature requests as pending posts. */
export const ingestInput = z.object({
  source: feedbackSource.default('manual'),
  text: z.string().min(1).max(20_000),
  author: z.object({ email: z.email().optional(), name: z.string().optional() }).optional(),
  url: z.string().optional(),
})
export type IngestInput = z.infer<typeof ingestInput>

export const askInput = z.object({ question: z.string().min(1).max(500) })
export type AskInput = z.infer<typeof askInput>

// --- Surveys (Phase 16) ---
export const createSurveyInput = z.object({
  name: z.string().min(1),
  type: surveyType,
  question: z.string().min(1).max(300),
  config: z
    .object({
      scaleMin: z.number().int().optional(),
      scaleMax: z.number().int().optional(),
      lowLabel: z.string().optional(),
      highLabel: z.string().optional(),
      options: z.array(z.string()).optional(),
    })
    .default({}),
  segmentId: z.string().nullable().optional(),
  isActive: z.boolean().default(false),
})
export type CreateSurveyInput = z.infer<typeof createSurveyInput>
export const updateSurveyInput = createSurveyInput.partial()
export type UpdateSurveyInput = z.infer<typeof updateSurveyInput>

/** A public respondent's answer — exactly one field is used per survey type. */
export const submitSurveyResponseInput = z.object({
  value: z.number().int().optional(),
  text: z.string().max(2000).optional(),
  choice: z.string().optional(),
})
export type SubmitSurveyResponseInput = z.infer<typeof submitSurveyResponseInput>

/** Aggregated survey results for the admin dashboard. */
export const surveyResults = z.object({
  responseCount: z.number().int(),
  average: z.number().nullable(),
  nps: z.number().nullable(), // -100..100 for NPS surveys
  csatPercent: z.number().nullable(), // 0..100 (top-2-box) for csat/rating
  distribution: z.record(z.string(), z.number().int()), // value → count
  choices: z.record(z.string(), z.number().int()), // option → count
  texts: z.array(z.string()),
})
export type SurveyResults = z.infer<typeof surveyResults>

// --- Integrations breadth (Phase 15) ---
export const setDiscordInput = z.object({ webhookUrl: z.url() })
export type SetDiscordInput = z.infer<typeof setDiscordInput>

/**
 * A Segment-compatible inbound event (identify / group). Used by the inbound webhook to
 * upsert end-users + companies automatically — no per-user JWT wiring.
 */
export const inboundEvent = z.object({
  type: z.enum(['identify', 'group', 'track', 'page', 'screen', 'alias']),
  userId: z.string().optional(),
  anonymousId: z.string().optional(),
  groupId: z.string().optional(),
  traits: z.record(z.string(), z.unknown()).optional(),
})
export type InboundEvent = z.infer<typeof inboundEvent>

// --- Score fields (weighted prioritization, Phase 12) ---
export const createScoreFieldInput = z.object({
  key: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_]+$/, 'lowercase letters, numbers and underscores only'),
  label: z.string().min(1),
  weight: z.number().default(1),
  position: z.number().int().optional(),
})
export type CreateScoreFieldInput = z.infer<typeof createScoreFieldInput>
export const updateScoreFieldInput = createScoreFieldInput.partial()
export type UpdateScoreFieldInput = z.infer<typeof updateScoreFieldInput>
