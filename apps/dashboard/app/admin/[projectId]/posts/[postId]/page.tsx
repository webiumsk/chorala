import {
  comments as commentSvc,
  insights as insightSvc,
  integrations,
  members as memberSvc,
  posts as postSvc,
  scoreFields as scoreFieldSvc,
  statuses as statusSvc,
  storage as storageSvc,
  tags as tagSvc,
} from '@chorala/core'
import Link from 'next/link'
import type { ReactNode } from 'react'
import {
  CommentForm,
  DedupSuggestions,
  MergeControl,
  TagEditor,
} from '@/components/detail-controls'
import { GithubIssueButton } from '@/components/github-button'
import { InsightPanel } from '@/components/insight-panel'
import { PinButton, StatusSelect } from '@/components/post-controls'
import { AssigneeSelect, ScoreEditor, VoteForForm } from '@/components/triage-controls'
import { Badge, Card, VotePill } from '@/components/ui'
import { requireAuthContext } from '@/lib/session'

const SectionLabel = ({ children }: { children: ReactNode }) => (
  <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-faint">
    {children}
  </p>
)

const money = (n: number) => `$${n.toLocaleString('en-US')}`

// AI depth (Phase 20): sentiment chip from the post's lexicon/LLM score.
function SentimentBadge({ label }: { label?: string | null }) {
  if (!label) return null
  const map: Record<string, { cls: string; icon: string }> = {
    positive: { cls: 'bg-emerald-500/10 text-emerald-600', icon: '☺' },
    neutral: { cls: 'bg-ink/[0.06] text-ink-soft', icon: '•' },
    negative: { cls: 'bg-red-500/10 text-red-600', icon: '☹' },
  }
  const s = map[label] ?? map.neutral
  return (
    <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${s?.cls}`}>
      {s?.icon} {label}
    </span>
  )
}

export default async function PostDetail({
  params,
}: {
  params: Promise<{ projectId: string; postId: string }>
}) {
  const { projectId, postId } = await params
  const ctx = await requireAuthContext()
  const [
    post,
    statuses,
    allTags,
    postTags,
    thread,
    allPosts,
    dedupSuggestions,
    ints,
    issue,
    context,
    attachments,
    customer,
    members,
    scoreFields,
    postInsights,
  ] = await Promise.all([
    postSvc.getPost(ctx, projectId, postId),
    statusSvc.listStatuses(ctx, projectId),
    tagSvc.listTags(ctx, projectId),
    tagSvc.listPostTags(ctx, projectId, postId),
    commentSvc.listAdminComments(ctx, projectId, postId),
    postSvc.listPosts(ctx, projectId, {}),
    postSvc.getDedupSuggestions(ctx, projectId, postId),
    integrations.listIntegrations(ctx, projectId),
    integrations.getPostIssue(ctx, projectId, postId),
    postSvc.getContext(ctx, projectId, postId),
    storageSvc.listAttachmentsForPost(ctx, projectId, postId),
    postSvc.getPostCustomer(ctx, projectId, postId),
    memberSvc.listMembers(ctx),
    scoreFieldSvc.listScoreFields(ctx, projectId),
    insightSvc.listInsights(ctx, projectId, { postId }),
  ])
  const contextEntries = Object.entries(context.context ?? {})
  const hasContext = !!context.appVersion || contextEntries.length > 0
  const githubConnected = ints.some((i) => i.type === 'github')
  const candidates = allPosts
    .filter((p) => p.id !== postId)
    .map((p) => ({ id: p.id, title: p.title }))

  return (
    <div className="space-y-5">
      <Link
        href={`/admin/${projectId}/posts`}
        className="inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft transition hover:text-accent"
      >
        <span aria-hidden>←</span> Back to posts
      </Link>

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
        <div className="space-y-5 lg:col-span-2">
          <Card className="p-6">
            <div className="flex items-start gap-5">
              <VotePill count={post.voteCount} size="lg" />
              <div className="min-w-0 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="font-display text-2xl leading-tight tracking-[-0.02em]">
                    {post.title}
                  </h1>
                  <SentimentBadge label={post.sentimentLabel} />
                </div>
                <p className="mt-2.5 whitespace-pre-wrap leading-relaxed text-ink-soft">
                  {post.body || '—'}
                </p>
              </div>
            </div>
          </Card>

          {attachments.length > 0 && (
            <Card className="p-6">
              <SectionLabel>Screenshots</SectionLabel>
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {attachments.map((a) => (
                  <a
                    key={a.id}
                    href={`/admin-media/${a.id}?projectId=${projectId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="group block overflow-hidden rounded-xl border border-line transition hover:border-accent"
                  >
                    {/* biome-ignore lint/performance/noImgElement: admin-only, auth-gated byte stream */}
                    <img
                      src={`/admin-media/${a.id}?projectId=${projectId}`}
                      alt="Bug report screenshot"
                      className="h-32 w-full bg-ink/[0.03] object-cover transition group-hover:opacity-90"
                    />
                  </a>
                ))}
              </div>
            </Card>
          )}

          <Card className="p-6">
            <SectionLabel>Evidence — customer quotes</SectionLabel>
            <p className="mb-3 -mt-1 text-xs text-ink-faint">
              Link what real customers said (and which accounts) to this request — it drives the
              “most evidenced” ranking in Analytics.
            </p>
            <InsightPanel projectId={projectId} postId={postId} insights={postInsights} />
          </Card>

          <Card className="p-6">
            <SectionLabel>Discussion</SectionLabel>
            <div className="mb-4 space-y-3">
              {thread.length === 0 && (
                <p className="text-sm text-ink-faint">No comments yet — start the conversation.</p>
              )}
              {thread.map((c) => (
                <div
                  key={c.id}
                  className={
                    c.isInternal
                      ? 'rounded-xl border border-accent/25/70 bg-accent-soft p-3.5 text-sm'
                      : 'rounded-xl bg-paper/70 p-3.5 text-sm'
                  }
                >
                  {c.isInternal && (
                    <Badge className="mb-1.5 border-accent/30/60 bg-accent-soft text-accent">
                      Internal
                    </Badge>
                  )}
                  <p className="whitespace-pre-wrap leading-relaxed">{c.body}</p>
                </div>
              ))}
            </div>
            <CommentForm projectId={projectId} postId={postId} />
          </Card>
        </div>

        <div className="space-y-4">
          {(customer.company || customer.endUser) && (
            <Card className="p-5">
              <SectionLabel>Customer</SectionLabel>
              {customer.endUser && (
                <p className="text-sm font-medium text-ink">
                  {customer.endUser.name ||
                    customer.endUser.email ||
                    (customer.endUser.isAnonymous ? 'Anonymous' : 'Unknown')}
                </p>
              )}
              {customer.company ? (
                <div className="mt-2 flex items-center justify-between gap-2">
                  <Link
                    href={`/admin/${projectId}/posts?companyId=${customer.company.id}`}
                    className="min-w-0 truncate text-sm text-ink-soft transition hover:text-accent"
                  >
                    {customer.company.name}
                    {customer.company.plan ? ` · ${customer.company.plan}` : ''}
                  </Link>
                  <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                    {money(customer.company.mrr)}
                  </span>
                </div>
              ) : (
                <p className="mt-1 text-xs text-ink-faint">No company linked.</p>
              )}
            </Card>
          )}
          <DedupSuggestions projectId={projectId} postId={postId} suggestions={dedupSuggestions} />
          <Card className="space-y-4 p-5">
            <div>
              <SectionLabel>Status</SectionLabel>
              <StatusSelect
                projectId={projectId}
                postId={postId}
                statusId={post.statusId}
                statuses={statuses}
              />
            </div>
            <div>
              <SectionLabel>Owner</SectionLabel>
              <AssigneeSelect
                projectId={projectId}
                postId={postId}
                assigneeMemberId={post.assigneeMemberId}
                members={members}
              />
            </div>
            <div>
              <SectionLabel>Pin to top</SectionLabel>
              <PinButton projectId={projectId} postId={postId} pinned={post.isPinned} />
            </div>
          </Card>

          {scoreFields.length > 0 && (
            <Card className="p-5">
              <SectionLabel>Priority score</SectionLabel>
              <ScoreEditor
                projectId={projectId}
                postId={postId}
                fields={post.fields}
                scoreFields={scoreFields}
              />
            </Card>
          )}

          <Card className="p-5">
            <SectionLabel>Vote on behalf</SectionLabel>
            <p className="mb-2 text-xs text-ink-faint">
              Log a request from a customer call — adds their vote by email.
            </p>
            <VoteForForm projectId={projectId} postId={postId} />
          </Card>

          <Card className="p-5">
            <SectionLabel>Tags</SectionLabel>
            <TagEditor
              projectId={projectId}
              postId={postId}
              allTags={allTags}
              current={postTags.map((t) => t.id)}
            />
          </Card>

          <Card className="p-5">
            <SectionLabel>Merge duplicate</SectionLabel>
            <MergeControl projectId={projectId} postId={postId} candidates={candidates} />
          </Card>

          <Card className="space-y-2 p-5">
            <SectionLabel>GitHub</SectionLabel>
            <GithubIssueButton
              projectId={projectId}
              postId={postId}
              connected={githubConnected}
              issue={issue}
            />
          </Card>

          {hasContext && (
            <Card className="p-5">
              <SectionLabel>Context</SectionLabel>
              {context.appVersion && (
                <Link
                  href={`/admin/${projectId}/posts?appVersion=${encodeURIComponent(context.appVersion)}`}
                  className="mb-3 inline-flex"
                >
                  <Badge className="border-accent/30 bg-accent-soft text-accent">
                    v{context.appVersion}
                  </Badge>
                </Link>
              )}
              {contextEntries.length > 0 && (
                <dl className="space-y-1.5 text-[13px]">
                  {contextEntries.map(([k, v]) => (
                    <div key={k} className="flex gap-2">
                      <dt className="shrink-0 font-medium text-ink-faint">{k}</dt>
                      <dd className="min-w-0 break-words text-right text-ink-soft tabular-nums">
                        {typeof v === 'string' ? v : JSON.stringify(v)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
