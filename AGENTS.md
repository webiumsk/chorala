# Owned Chorala fork

This repository is `webiumsk/chorala`, independently maintained for Satflux.
The Product Owner selected an owned fork and subsequently narrowed deployment to
Satflux only. Preserve inherited project features; do not turn this into a new SaaS
initiative or embed its AGPL server into Satflux's MIT application.

Read `docs/FORK_SCOPE.md`, `docs/SELF_HOSTING.md`, `CLAUDE.md`, `SPEC.md` and
`BUILD_PLAN.md` before implementation. Original phase plans are historical evidence;
do not restart completed phases. The fork's explicit accepted scope takes precedence
over stale scaffold, survey and deployment claims in older upstream instructions.

Communicate with the owner in Slovak; source, documentation and commits use English.
Check cwd, branch, status and remotes. Preserve unrelated work. Main owns integration,
shared documentation, commits and GitHub publication. Delegate substantial bounded
work to actual specialists with exclusive writable ownership. Use independent QA and
security reviewers; authors cannot approve their own security work.

The upstream remote is read-only. Publish only to the authorized owned repository.
Do not merge, release or deploy without explicit applicable owner approval. Do not
change global tools, trust, credentials or configuration. Use Node 24 and the pinned
pnpm version; keep package changes locked. No Graphify graph is currently available;
do not silently install or rebuild it.

Preserve organization/project authorization, documented roles and key scopes,
public/private visibility, signed identity boundaries and account-bound drafts.
Screenshots must be user initiated and reviewable. Never collect wallet proofs,
recovery material, authentication headers or private host-app state automatically.
Keep AGPL, MIT, Preact and font notices intact.

Tests must use verified disposable targets. `compose.test.yml` supplies tmpfs
PostgreSQL and Redis on an internal network. Never seed production, use production
credentials or let browser tests default to a deployed hostname. Inspect actual
environment and cached configuration first. Run appropriate lint, typecheck, build,
Vitest and synthetic browser checks. Keep limitations and inherited findings explicit.
