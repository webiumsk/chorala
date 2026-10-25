# Satflux-owned Chorala fork

## Authorization and source

The Product Owner selected an owned fork at `webiumsk/chorala`, based on upstream
[`2ge/chorala` revision `6cb0cc7`](https://github.com/2ge/chorala/tree/6cb0cc7bc2c13679f188834c47c08a3ed2024946).
Final intended use is a separately operated feedback service for **Satflux only**.
Existing multi-project capabilities remain intact; creating a general hosted SaaS
product is outside this work. Source implementation and GitHub preparation do not
authorize production deployment or access to historical hosted feedback.

The server retains AGPL-3.0. Widget and other MIT surfaces retain their package
notices. Vendored fonts retain their OFL notices and pinned provenance. Satflux is
an API client; no AGPL server code is copied into its application.

## Preserved capability baseline

| Area | Inherited functionality retained |
| --- | --- |
| Feedback | Boards, ideas/bugs, votes, comments, search and filters |
| Capture | User-initiated screenshots, preview, redaction/highlighting, application version |
| Delivery | Shadow-DOM widget, public portal, floating/manual/inline modes |
| Planning | Statuses, tags, roadmap, ETA, owners, duplicate merging |
| Communication | Changelog, subscriptions, email/in-app notifications and digests |
| Prioritization | Companies/MRR, segments, weighted scores, evidence, vote on behalf, analytics/CSV |
| AI | Provider-dependent summaries, translations, suggestions, clustering and reviewed drafts |
| Integrations | Implemented GitHub, Discord, inbound identification, signed webhooks, SDK/MCP |
| Other inherited features | Surveys, themes, administration and organization/project separation |

This is a source-preservation checklist, not a claim that every external provider
has been exercised. Email, AI and integrations require explicit staging configuration
and real delivery checks. Upstream Slack/Linear integration stubs and native mobile
SDK stubs remain stubs; they are not presented as delivered capabilities.

## Remediation and acceptance contracts

- Organization/project authorization precedes staff reads and writes, including
  internal comments, moderation, references and attachment downloads.
- API keys require explicit read/write scopes. Organization-wide operations and key
  management are restricted to privileged staff sessions. Members are read-only;
  moderators retain their dedicated moderation workflow.
- Public details, roadmap, comments and voting share visibility rules. Private
  boards, hidden reports and unapproved drafts cannot leak through a second view.
- Signing secrets are omitted from non-administrator project DTOs. End-user JWTs
  require HS256, issued/expiry times and a lifetime of at most 24 hours, preserving
  Satflux's existing one-hour claim format.
- Anonymous cookies are project scoped. Legacy identity migration verifies the
  original project; account and project switches clear all widget instances.
- Same-user token renewal changes headers without destroying drafts/screenshots.
  Diagnostic context retains HTTP origins rather than host-app paths or tokens.
- Upload requests and encoded strings are bounded before allocation. Actual static
  image decoding, dimensions, per-project transactional quotas and cleanup guard
  storage. Multi-frame images are rejected. Attachments remain staff-authorized.
- Public writes fail closed when their rate limiter is unavailable. Read-only
  feedback can degrade without permitting unlimited expensive writes.
- Fresh administrator setup requires explicit credentials, serializes concurrent
  attempts and refuses an occupied installation. Self-host signup defaults closed;
  no upstream demo credentials are advertised or installed.
- Docker persists and shares uploads, runs migrations before readiness, builds the
  widget, excludes secrets and uses configured owned hosts. Fonts are local assets.

## Integration with Satflux

Create the Satflux project on the owned instance. Configure only the required
application origins, project key, project ID, project API key and end-user signing
secret. Satflux's existing direct API integration supports a configurable instance
origin and its one-hour JWT format remains compatible. Rotate settings through the
normal protected deployment configuration; do not commit keys or use live feedback
as a health check. Preserve the existing CSRF protections in Satflux.

Public project links use the instance's `/portal/<projectId>` routes or a configured
project domain. Hosting the widget asset alone does not host or back up feedback data.

## Validation and release boundaries

Use Node 24, the locked dependencies and verified disposable PostgreSQL/Redis.
Independent QA exercised the actual built widget with every browser API intercepted,
including 401 retry, screenshot/draft retention, inline account reset and all six
locales. QA also forced two concurrent initial-administrator processes to wait on
the same advisory lock in a fresh test database: exactly one succeeded, one refused,
and exactly one user/account/member/organization/owner remained. That database was
removed without changing the shared test database.

Independent security review accepted the bounded fixes after closing a discovered
dashboard action recursion regression. Actual suite/build and GitHub results must be
recorded for the published revision; source inspection alone is not a test pass.

The generic webhook delivery path still needs a separate egress/SSRF/redirect
hardening review before enabling untrusted destinations. Runtime images retain the
upstream root-user baseline; no non-root isolation claim is made. Backup/restore and
owned-domain startup require the smoke checks in `SELF_HOSTING.md` before deployment.

Historical migration needs the old database plus attachment bytes and service
secrets, or a complete upstream export. Current upstream CSV is not a full backup.
No hosted posts, votes, comments or screenshots have been recovered or migrated.

## Completed local checks

The table includes initial source-fix recovery evidence and subsequent dependency
checks. See [dated validation](VALIDATION_2026-10-25.md) for revisions, independent
reviewers, the final lockfile, patched-graph CI and explicitly historical image proof.

| Check | Observed result |
| --- | --- |
| Vitest | 169 cases passed: API 66, core 54, widget 32, AI 14, database 3 |
| Node configuration tests | Final 11-case run passed, including canonical alias redirects |
| MCP HTTP / SMTP | Six real-SDK HTTP and four loopback SMTP cases passed; total suite now 190 cases |
| TypeScript | All 20 workspace tasks passed; final dashboard also passed Next's type gate |
| Build | All 15 workspace tasks passed; final dashboard rebuilt after runtime-policy/alias fixes |
| Biome | Passed with six unchanged warnings in untouched theme/AI files |
| Independent widget browser QA | Draft/screenshot renewal, account boundaries, six locales and license notices passed; every request intercepted |
| Independent bootstrap concurrency | Two blocked contenders, one creator, one refusal, one account/owner, disposable database removed |
| Actual browser journey | Login, public idea, vote, staff status mutation and public roadmap passed against the restored local stack |
| Live MCP | Nine tools exposed; scoped reads, post/comments, boards and search passed against the restored API |
| Actual Docker images | API, dashboard, worker and one-shot migration built and started |
| Persistence/recovery | Container recreation and full PostgreSQL/upload restore after deleting disposable volumes preserved relationships, authorization and screenshot bytes |
| Final runtime settings | Closed/open/closed registration rendering, canonical alias redirect, spoofed-host rejection, read-only upload mount and absence of operator `.env` passed |

These results concern synthetic local instances only. No production instance, hosted
feedback history, real TLS/DNS, SMTP/AI provider or external integration delivery was
changed or exercised. Redis job recovery was not tested. GitHub CI is separate evidence
for the exact published commit and must not be inferred from these local results.

The complete patched dependency graph has zero critical/high findings and four
documented moderate records, without suppressions. Independent security accepted
their inactive development-server conditions; see `DEPENDENCY_SECURITY.md`. Do not
start the legacy esbuild HTTP server, including on localhost, or expose mock/UI/HMR
test servers. The final widget build passed actual browser QA after the scoped
esbuild update, and fresh concurrent administrator bootstrap was repeated on the
updated Better Auth version. No application source was changed to satisfy either
proof.
