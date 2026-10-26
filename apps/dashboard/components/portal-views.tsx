import { publicFeed } from '@chorala/core'
import { notFound } from 'next/navigation'
import { ChangelogMarkdown } from '@/components/changelog-markdown'
import { PortalBoard, StatusPill, TagChip } from '@/components/portal-board'
import { PortalComment, PortalVote, SubscribeForm } from '@/components/portal-client'

type Props = { projectId: string; publicKey: string; locale?: string; basePath?: string }

export async function BoardView({
  projectId,
  publicKey,
  locale,
  basePath = '/',
  initialTag,
}: Props & { initialTag?: string }) {
  const { boards, posts } = await publicFeed.listPublicBoards(projectId, { locale, sort: 'top' })
  return (
    <div>
      <div className="mb-5">
        <h2 className="font-display text-3xl tracking-[-0.02em]">What should we build next?</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Suggest ideas, report bugs, and vote on what matters most to you — we read every one.
        </p>
      </div>
      <PortalBoard
        publicKey={publicKey}
        boards={boards.map((b) => ({
          id: b.id,
          slug: b.slug,
          name: b.name,
          description: b.description,
          kind: b.kind,
        }))}
        posts={posts.map((p) => ({
          id: p.id,
          boardId: p.boardId,
          title: p.title,
          body: p.body,
          voteCount: p.voteCount,
          commentCount: p.commentCount,
          hasVoted: p.hasVoted,
          createdAt: String(p.createdAt),
          status: p.status
            ? { name: p.status.name, color: p.status.color, kind: p.status.kind }
            : null,
          tags: p.tags ?? [],
        }))}
        basePath={basePath}
        initialTag={initialTag}
      />
    </div>
  )
}

export async function PostDetailView({
  projectId,
  publicKey,
  postId,
  locale,
  basePath = '/',
}: Props & { postId: string }) {
  const { post, comments } = await publicFeed.getPublicPost(projectId, postId, { locale })
  if (!post) notFound()
  return (
    <div>
      <a
        href={basePath}
        className="mb-5 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft transition hover:text-[var(--brand)]"
      >
        <span aria-hidden>←</span> Back to board
      </a>
      <div className="surface flex items-start gap-4 p-5">
        <PortalVote
          publicKey={publicKey}
          postId={post.id}
          count={post.voteCount}
          voted={!!post.hasVoted}
        />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl leading-tight tracking-[-0.02em]">{post.title}</h1>
            {post.status && <StatusPill status={post.status} />}
            {post.tags?.map((t) => (
              <a key={t.name} href={`${basePath}?tag=${encodeURIComponent(t.name)}`}>
                <TagChip tag={t} />
              </a>
            ))}
          </div>
          {post.body && (
            <p className="mt-2 whitespace-pre-wrap leading-relaxed text-ink-soft">{post.body}</p>
          )}
        </div>
      </div>

      <h2 className="mb-3 mt-7 text-sm font-semibold uppercase tracking-[0.08em] text-ink-faint">
        {comments.length} {comments.length === 1 ? 'comment' : 'comments'}
      </h2>
      <div className="space-y-2.5">
        {comments.map((c) => (
          <div key={c.id} className="surface p-3.5 text-sm">
            <p className="whitespace-pre-wrap leading-relaxed">{c.body}</p>
            <p className="mt-1.5 text-xs text-ink-faint">
              {new Date(c.createdAt).toLocaleDateString()}
            </p>
          </div>
        ))}
      </div>
      <div className="mt-4">
        <PortalComment publicKey={publicKey} postId={post.id} />
      </div>
    </div>
  )
}

export async function RoadmapView({ projectId, locale }: Props) {
  const { columns } = await publicFeed.getRoadmap(projectId, { locale })
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      {columns.map((col) => (
        <div key={col.status.id}>
          <div className="mb-2 flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: col.status.color }} />
            <span className="font-semibold tracking-[-0.01em]">{col.status.name}</span>
          </div>
          <div className="space-y-2">
            {col.posts.length === 0 && <p className="text-xs text-ink-faint">Nothing here yet.</p>}
            {col.posts.map((p) => (
              <div key={p.id} className="surface p-3 text-sm">
                <p className="font-medium">{p.title}</p>
                <p className="mt-1 text-xs text-ink-faint">▲ {p.voteCount}</p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export async function ChangelogView({ projectId }: Props) {
  const entries = await publicFeed.getPublicChangelog(projectId)
  return (
    <div className="space-y-6">
      <div className="surface p-4">
        <p className="mb-2 text-sm font-semibold">Subscribe to updates</p>
        <SubscribeForm projectId={projectId} />
      </div>
      {entries.length === 0 && <p className="text-ink-faint">No changelog entries yet.</p>}
      {entries.map((e) => (
        <article key={e.id} className="border-b border-line pb-5">
          <div className="mb-1 flex items-center gap-2">
            {e.labels.map((l) => (
              <span key={l} className="rounded-full bg-ink/5 px-2 py-0.5 text-xs text-ink-soft">
                {l}
              </span>
            ))}
            {e.publishedAt && (
              <span className="text-xs text-ink-faint">
                {new Date(e.publishedAt).toLocaleDateString()}
              </span>
            )}
          </div>
          <h2 className="font-display text-xl tracking-[-0.01em]">{e.title}</h2>
          <div className="mt-1 text-ink-soft">
            <ChangelogMarkdown body={e.body} />
          </div>
        </article>
      ))}
    </div>
  )
}

/** Themed portal chrome shared by the /portal/[id] route and custom domains. */
export function PortalShell({
  name,
  brand,
  basePath,
  children,
}: {
  name: string
  brand: string
  basePath: string
  children: React.ReactNode
}) {
  const tabs: [string, string][] = [
    ['', 'Board'],
    ['roadmap', 'Roadmap'],
    ['changelog', 'Changelog'],
  ]
  return (
    <div style={{ ['--brand' as string]: brand }} className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-line/80 bg-paper/85 backdrop-blur-md">
        <div className="mx-auto flex max-w-3xl items-center gap-4 px-5 py-5">
          <h1 className="font-display text-2xl tracking-[-0.02em]">{name}</h1>
          <nav className="ml-auto flex gap-1 text-sm">
            {tabs.map(([slug, label]) => (
              <a
                key={label}
                href={`${basePath}${slug}`}
                className="rounded-full px-3 py-1.5 font-medium text-ink-soft transition hover:bg-ink/5 hover:text-ink"
              >
                {label}
              </a>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-5 py-8 rise">{children}</main>
      <footer className="mx-auto max-w-3xl px-5 pb-10 pt-4 text-xs text-ink-faint">
        Powered by <span className="font-display text-sm text-ink-soft">Chorala</span>
      </footer>
    </div>
  )
}
