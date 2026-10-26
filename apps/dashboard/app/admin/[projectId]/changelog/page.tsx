import { canManageOrg, changelog as changelogSvc, segments as segmentSvc } from '@chorala/core'
import { ChangelogManager } from '@/components/changelog-manager'
import { requireAuthContext } from '@/lib/session'

export default async function ChangelogPage({
  params,
}: {
  params: Promise<{ projectId: string }>
}) {
  const { projectId } = await params
  const ctx = await requireAuthContext()
  const [entries, segments] = await Promise.all([
    changelogSvc.listChangelog(ctx, projectId),
    segmentSvc.listSegments(ctx, projectId),
  ])
  return (
    <ChangelogManager
      key={projectId}
      projectId={projectId}
      canWrite={canManageOrg(ctx)}
      entries={entries.map((entry) => ({
        id: entry.id,
        title: entry.title,
        body: entry.body,
        labels: entry.labels,
        status: entry.status,
        segmentId: entry.segmentId,
        recipientCount: entry.recipientCount,
      }))}
      segments={segments.map((segment) => ({
        id: segment.id,
        name: segment.name,
        matchCount: segment.matchCount,
      }))}
    />
  )
}
