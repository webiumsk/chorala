import { z } from 'zod'
import {
  aiJobKind,
  aiJobStatus,
  boardKind,
  changelogStatus,
  insightSource,
  integrationType,
  isoDate,
  memberRole,
  orgPlan,
  prefixedId,
  segmentDefinition,
  statusKind,
  surveyType,
  timestamps,
  webhookEvent,
} from './common.ts'

const jsonObject = z.record(z.string(), z.unknown())

// --- Tenancy & people ---
export const organization = z
  .object({
    id: prefixedId('org'),
    slug: z.string(),
    name: z.string(),
    plan: orgPlan,
    defaultLocale: z.string(),
    locales: z.array(z.string()),
    settings: jsonObject,
  })
  .extend(timestamps.shape)

export const member = z
  .object({
    id: prefixedId('mem'),
    orgId: prefixedId('org'),
    userId: z.string(),
    role: memberRole,
  })
  .extend(timestamps.shape)

export const project = z
  .object({
    id: prefixedId('proj'),
    orgId: prefixedId('org'),
    slug: z.string(),
    name: z.string(),
    isPublic: z.boolean(),
    customDomain: z.string().nullable(),
    publicKey: z.string(),
    allowedOrigins: z.array(z.string()),
    widgetSettings: jsonObject,
  })
  .extend(timestamps.shape)

export const endUser = z
  .object({
    id: prefixedId('eu'),
    projectId: prefixedId('proj'),
    externalId: z.string().nullable(),
    email: z.email().nullable(),
    name: z.string().nullable(),
    avatarUrl: z.url().nullable(),
    isAnonymous: z.boolean(),
    locale: z.string(),
    companyId: prefixedId('co').nullable(),
    metadata: jsonObject,
    segment: jsonObject,
  })
  .extend(timestamps.shape)

export const scoreField = z
  .object({
    id: prefixedId('sf'),
    projectId: prefixedId('proj'),
    key: z.string(),
    label: z.string(),
    weight: z.number(),
    position: z.number().int(),
  })
  .extend(timestamps.shape)

export const company = z
  .object({
    id: prefixedId('co'),
    projectId: prefixedId('proj'),
    externalId: z.string().nullable(),
    name: z.string(),
    domain: z.string().nullable(),
    mrr: z.number().int(),
    plan: z.string().nullable(),
    metadata: jsonObject,
  })
  .extend(timestamps.shape)

// --- Feedback ---
export const board = z
  .object({
    id: prefixedId('board'),
    projectId: prefixedId('proj'),
    slug: z.string(),
    name: z.string(),
    description: z.string().nullable(),
    kind: boardKind,
    isPrivate: z.boolean(),
    position: z.number().int(),
  })
  .extend(timestamps.shape)

export const status = z
  .object({
    id: prefixedId('status'),
    projectId: prefixedId('proj'),
    name: z.string(),
    color: z.string(),
    kind: statusKind,
    position: z.number().int(),
    showOnRoadmap: z.boolean(),
  })
  .extend(timestamps.shape)

export const post = z
  .object({
    id: prefixedId('post'),
    boardId: prefixedId('board'),
    projectId: prefixedId('proj'),
    authorEndUserId: prefixedId('eu').nullable(),
    authorMemberId: prefixedId('mem').nullable(),
    title: z.string(),
    body: z.string(),
    originalLocale: z.string(),
    statusId: prefixedId('status').nullable(),
    isPinned: z.boolean(),
    voteCount: z.number().int(),
    commentCount: z.number().int(),
    mergedIntoPostId: prefixedId('post').nullable(),
    eta: isoDate.nullable(),
    // Submission context (Sentry/Canny style): a first-class, filterable version string.
    // The free-form `context` map is admin-only and not part of this public entity.
    appVersion: z.string().nullable(),
    // AI depth (Phase 20): sentiment score in [-1, 1] and a 3-way label (null until scored).
    sentiment: z.number().nullable().optional(),
    sentimentLabel: z.enum(['negative', 'neutral', 'positive']).nullable().optional(),
  })
  .extend(timestamps.shape)

export const attachment = z
  .object({
    id: prefixedId('att'),
    projectId: prefixedId('proj'),
    postId: prefixedId('post').nullable(),
    kind: z.enum(['screenshot', 'file']),
    mimeType: z.string(),
    byteSize: z.number().int(),
    width: z.number().int().nullable(),
    height: z.number().int().nullable(),
    // bytes are served separately (admin-only); storageKey is never serialized to clients
  })
  .extend(timestamps.shape)

export const postTranslation = z
  .object({
    id: prefixedId('ptr'),
    postId: prefixedId('post'),
    locale: z.string(),
    title: z.string(),
    body: z.string(),
    isAuto: z.boolean(),
  })
  .extend(timestamps.shape)

export const vote = z
  .object({
    id: prefixedId('vote'),
    postId: prefixedId('post'),
    endUserId: prefixedId('eu'),
    weight: z.number().int(),
  })
  .extend(timestamps.shape)

export const comment = z
  .object({
    id: prefixedId('cmt'),
    postId: prefixedId('post'),
    authorEndUserId: prefixedId('eu').nullable(),
    authorMemberId: prefixedId('mem').nullable(),
    parentCommentId: prefixedId('cmt').nullable(),
    body: z.string(),
    isInternal: z.boolean(),
  })
  .extend(timestamps.shape)

export const tag = z
  .object({
    id: prefixedId('tag'),
    projectId: prefixedId('proj'),
    name: z.string(),
    color: z.string(),
  })
  .extend(timestamps.shape)

// --- Communication ---
export const changelogDisplayDate = z.iso
  .date()
  .refine((value) => !value.startsWith('0000-'), 'The calendar year must be positive')

export const changelogEntry = z
  .object({
    id: prefixedId('cl'),
    projectId: prefixedId('proj'),
    title: z.string(),
    body: z.string(),
    status: changelogStatus,
    displayDate: changelogDisplayDate.nullable().optional(),
    publishedAt: isoDate.nullable(),
    labels: z.array(z.string()),
    linkedPostIds: z.array(prefixedId('post')),
    segmentId: prefixedId('seg').nullable(),
    recipientCount: z.number().int(),
  })
  .extend(timestamps.shape)

export const segment = z
  .object({
    id: prefixedId('seg'),
    projectId: prefixedId('proj'),
    name: z.string(),
    definition: segmentDefinition,
  })
  .extend(timestamps.shape)

export const survey = z
  .object({
    id: prefixedId('sv'),
    projectId: prefixedId('proj'),
    name: z.string(),
    type: surveyType,
    question: z.string(),
    config: jsonObject,
    segmentId: prefixedId('seg').nullable(),
    isActive: z.boolean(),
  })
  .extend(timestamps.shape)

export const changelogSubscriber = z
  .object({
    id: prefixedId('sub'),
    projectId: prefixedId('proj'),
    email: z.email(),
    endUserId: prefixedId('eu').nullable(),
  })
  .extend(timestamps.shape)

export const notification = z
  .object({
    id: prefixedId('ntf'),
    recipientType: z.enum(['member', 'end_user']),
    recipientId: z.string(),
    type: z.string(),
    payload: jsonObject,
    readAt: isoDate.nullable(),
  })
  .extend(timestamps.shape)

// --- Integration & platform ---
export const integration = z
  .object({
    id: prefixedId('intg'),
    projectId: prefixedId('proj'),
    type: integrationType,
    config: jsonObject,
    // secret is never serialized to clients
  })
  .extend(timestamps.shape)

export const webhook = z
  .object({
    id: prefixedId('wh'),
    projectId: prefixedId('proj'),
    url: z.url(),
    events: z.array(webhookEvent),
    isActive: z.boolean(),
  })
  .extend(timestamps.shape)

export const apiKey = z
  .object({
    id: prefixedId('key'),
    projectId: prefixedId('proj'),
    name: z.string(),
    prefix: z.string(),
    scopes: z.array(z.string()),
    lastUsedAt: isoDate.nullable(),
  })
  .extend(timestamps.shape)

export const auditLog = z
  .object({
    id: prefixedId('audit'),
    orgId: prefixedId('org'),
    actor: z.string(),
    action: z.string(),
    target: z.string(),
    metadata: jsonObject,
  })
  .extend(timestamps.shape)

export const insight = z
  .object({
    id: prefixedId('ins'),
    projectId: prefixedId('proj'),
    postId: prefixedId('post'),
    quote: z.string(),
    source: insightSource,
    customerEmail: z.string().nullable(),
    companyId: prefixedId('co').nullable(),
    createdByMemberId: prefixedId('mem').nullable(),
  })
  .extend(timestamps.shape)

export const aiJob = z
  .object({
    id: prefixedId('aijob'),
    projectId: prefixedId('proj'),
    kind: aiJobKind,
    status: aiJobStatus,
    inputRef: z.string().nullable(),
    result: jsonObject.nullable(),
    error: z.string().nullable(),
  })
  .extend(timestamps.shape)

export const feedbackCluster = z
  .object({
    id: prefixedId('clust'),
    projectId: prefixedId('proj'),
    label: z.string(),
    summary: z.string(),
    postIds: z.array(prefixedId('post')),
    computedAt: isoDate.nullable(),
  })
  .extend(timestamps.shape)

// --- Inferred types ---
export type Organization = z.infer<typeof organization>
export type Member = z.infer<typeof member>
export type Project = z.infer<typeof project>
export type EndUser = z.infer<typeof endUser>
export type Company = z.infer<typeof company>
export type ScoreField = z.infer<typeof scoreField>
export type Board = z.infer<typeof board>
export type Status = z.infer<typeof status>
export type Post = z.infer<typeof post>
export type Attachment = z.infer<typeof attachment>
export type PostTranslation = z.infer<typeof postTranslation>
export type Vote = z.infer<typeof vote>
export type Comment = z.infer<typeof comment>
export type Tag = z.infer<typeof tag>
export type ChangelogEntry = z.infer<typeof changelogEntry>
export type Segment = z.infer<typeof segment>
export type Survey = z.infer<typeof survey>
export type ChangelogSubscriber = z.infer<typeof changelogSubscriber>
export type Notification = z.infer<typeof notification>
export type Integration = z.infer<typeof integration>
export type Webhook = z.infer<typeof webhook>
export type ApiKey = z.infer<typeof apiKey>
export type AuditLog = z.infer<typeof auditLog>
export type Insight = z.infer<typeof insight>
export type AiJob = z.infer<typeof aiJob>
export type FeedbackCluster = z.infer<typeof feedbackCluster>
