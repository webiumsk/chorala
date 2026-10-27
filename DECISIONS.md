# DECISIONS.md

Audit trail of judgement calls made while building Chorala where SPEC.md left a
choice. Format: `- [phase] chose X over Y because Z`.

## Rebrand → Chorala (2026-06-14)
- [brand] Named the product **Chorala** (chorala.com) — registered, CF zone active. The original
  build-time codename was a common dictionary word whose `.com` was already owned by a third
  party (a search for the brand would leak elsewhere); "Chorala" (a coined word, from *chorus* —
  many voices) is an exact-match domain the project fully owns.
- [brand] **Full purge:** every trace of the old codename was renamed to Chorala in one
  case-exact pass across the whole repo — package scope `@chorala/*`, env prefix `CHORALA_*`,
  wire-protocol tokens (`window.Chorala`, `chorala:engaged`, `postMessage source:'chorala'`,
  `X-Chorala-Key`/`X-Chorala-Signature`), widget CSS vars/classes (`--chorala-*`, `chorala-*`),
  cookies (`chorala-theme`, `chorala_uid`), Postgres DB/role, Redis/BullMQ prefix, and PM2
  process names. The codename appears nowhere in the source (guarded by a test, see §13).
- [brand] The embed wire-protocol rename is a **coordinated cutover** with the one live embed
  (MusicAha): no back-compat aliases are kept. The host page must update `window.Chorala`,
  the `chorala:engaged` listener and `source:'chorala'` check — see the migration note handed
  to the MusicAha side.
- [brand] Canonical URL is `https://chorala.com` (`CHORALA_PUBLIC_URL` value); `idea.2pu.net`
  + `www.chorala.com` kept as trusted origins/admin hosts so all routes still log in.
- [brand] Migrated the live seeded admin in place and re-hashed its password (no user delete)
  to avoid cascading the live posts/members it authored; later deleted in favour of the real
  owner (`satoshinakashu@pm.me`) + an isolated public demo account (`demo@chorala.com`).
- [brand] Customer feedback portals (`/site/*`) now set their own indexable, project-named
  metadata instead of inheriting the admin dashboard's `Chorala — Admin` + noindex.

## Infra: chorala.com routing (2026-06-14)
- [infra] `chorala.com` rides the existing path: Cloudflare (2ge account, Flexible SSL) →
  lb2 (`172.20.10.12`) `20-frontend.cfg` `aidev` backend (`172.20.111.111:80`) → this box's
  haproxy `is_chorala` → `idea_api`(`:8787`)/`idea_app`(`:3015`). Mirrors `musicaha.com`
  exactly; no lb1/lb2 net-new components. (aidev SSH egress to lb1:2223 was opened for this.)

## Embed: one-tag self-configuring widget (2026-06-14)
- [widget] Adopted the modern Plausible/Umami-style embed: a single
  `<script async src=".../widget.js" data-chorala-key="pk_…">` self-inits the widget — no
  IIFE, no queue stub, no `init()` call. SSO fits the same tag via `data-jwt`; JS-computed
  config uses a `window.choralaSettings` object. The self-init runs only if no `Chorala('init')`
  was queued programmatically, so existing/queue embeds still work. `document.currentScript`
  is null for async scripts, so it falls back to `querySelector('script[data-chorala-key]')`.
- [widget] **Removed `packages/widget-loader`** (deviates from SPEC §3/§5, which is now stale).
  It was unused — nothing imported it, the API never served a `loader.js`, and the queue
  support it duplicated already lives in `widget.js`. The one-tag form makes a standalone
  loader obsolete. Dropping it keeps zero backward-compat cost.

## Setup / host adaptation
- [setup] Build in-place at repo root (no nested `chorala/` dir) over a `chorala/`
  subfolder, because this dev host already routes `idea.2pu.net` to this project
  directory; the `@chorala/*` scope and `CHORALA_` env prefix still carry the brand token.
- [setup] Relaxed `engines.node` to `>=22` over SPEC §4's locked Node 24, because
  the dev host runs Node v22.22.2 (a current LTS that runs the whole stack) and has
  no version manager installed. Revisit before any production cut.
- [setup] Local dev points `DATABASE_URL` at the shared Postgres 16 cluster (DB
  `chorala`) and `REDIS_URL` at the shared Redis (db index 9, BullMQ key prefix `chorala`)
  over spinning project-local containers, per this host's PORTS.md conventions. The
  Docker Compose self-host path (Phase 8) still ships dedicated postgres+redis so the
  one-command self-host promise (SPEC §14) holds for external users.
- [setup] AI verified via the Vitest mock provider + `NoopProvider` degradation path
  (both already required by SPEC §11/§13) over a live model, because the host has no
  local Ollama (`:11434` is closed). The pluggable provider layer is built in full; a
  live provider is a config change away.
- [setup] API (`:8787`) will be exposed via haproxy path-routing on `idea.2pu.net`
  (`/api/*` and `/widget.js` → `:8787`, everything else → dashboard `:3015`) over a
  second hostname, mirroring the `tapmenu.ai` split. Wired when the API first runs
  (Phase 2), not in Phase 0.

## Phase 0
- [phase0] Per-package `build` scripts are no-op stubs until each package's
  implementing phase, so `pnpm build` stays green and the repo is runnable at every
  commit boundary (CLAUDE.md §3). Each is replaced with a real build in its phase.
- [phase0] Pinned tooling at the latest stable majors from SPEC §4: biome 2,
  turbo 2, typescript 5. `docker-compose.yml` ships only postgres(+pgvector) and redis
  in Phase 0; the api/dashboard/worker/caddy services are added in Phase 8.

## Phase 1
- [phase1] Internal packages export TypeScript **source** directly (`main`/`exports` →
  `./src/index.ts`) and `build` = `tsc --noEmit` (typecheck only), over compiling each to
  `dist`. Reason: the whole stack is bundler-driven (tsx, esbuild, Next, tsup, vitest), so
  source consumption removes a build-ordering tax and keeps dev iteration instant. tsconfig
  base therefore uses `module: Preserve` + `moduleResolution: Bundler`.
- [phase1] Did **not** use `drizzle-zod`; the `packages/types` zod contract is hand-written
  so the package depends only on `zod` and stays safe for the MIT widget/mcp/sdk packages to
  consume (CLAUDE.md §code-conventions / SPEC §3).
- [phase1] Vitest pinned to **3.2.6** (SPEC §4 locks major 3) even though 4.x is out.
- [phase1] Enum-like columns modeled as Drizzle `text().$type<...>()` rather than Postgres
  `pgEnum`, to avoid enum-alter migration friction; zod schemas enforce the allowed values.
- [phase1] Better Auth core tables (`users/sessions/accounts/verifications`) are defined in
  the Drizzle schema now (plural names) so migrations create them in Phase 1; Better Auth is
  configured to map its models to these tables in Phase 2.
- [phase1] Seed creates the admin `user` + `member` (owner) rows but defers the password
  **credential** to Phase 2, where Better Auth's hasher is available. `SEED_ADMIN`
  (admin@chorala.com / choralaadmin123) is exported from the seed for Phase 2 to consume.
- [phase1] Prepended `CREATE EXTENSION IF NOT EXISTS vector;` to migration `0000` (drizzle-kit
  does not emit it) so a fresh DB / CI provisions pgvector self-sufficiently.
- [phase1] `db:push` needs a TTY to confirm, so the canonical apply path is
  `db:generate` (committed SQL migrations, a BUILD_PLAN deliverable) + `db:migrate`
  (non-interactive). `db:push` remains for quick local iteration.

## Phase 2
- [phase2] Core services are organized one-file-per-resource and exported as **namespaces**
  (`core.projects.*`, `core.posts.*`) so route handlers read declaratively and stay thin.
- [phase2] `getProject` is the single scope gate reused by every nested service; it enforces
  org ownership AND, for api-key callers, restricts access to the single scoped project
  (api keys are project-scoped per SPEC §8.1). Caught + fixed a cross-project read during
  manual testing.
- [phase2] Better Auth `seed:admin` script recreates the seeded admin via Better Auth's
  sign-up API and re-attaches the preserved org membership, rather than reverse-engineering
  its password-hash format — robust across Better Auth versions.
- [phase2] Post reads use an explicit column selection that **omits the `embedding` vector**
  so 768-float arrays never leak into API responses or waste bandwidth.
- [phase2] Route handlers validate with the zod schemas from `@chorala/types` (`schema.parse`);
  a single Hono `onError` maps `AppError`/`ZodError` to the `{ error: { code, message } }`
  contract. No `@hono/zod-validator` dependency needed.
- [phase2] Parent-mounted route params (`projectId`, `postId`) type as `string | undefined`
  under `noUncheckedIndexedAccess`; a `reqParam()` helper narrows + 400s if absent.
- [phase2] `noNonNullAssertion` disabled for test/seed files via a Biome override (idiomatic
  there); enforced everywhere else.
- [phase2] haproxy: added `idea_api` backend + `is_idea_api` ACL so `idea.2pu.net/api/*` and
  `/widget.js` route to `:8787`, everything else to the dashboard `:3015`. API runs via
  `tsx` for now (PM2/Docker packaging is Phase 8). `/health` is direct-only (not under /api).

## Phase 3
- [phase3] End-user JWT verified with **jose** (`jwtVerify`, HS256) — constant-time HMAC
  per SPEC §13 — rather than hand-rolling JWT crypto. jose isn't in SPEC §4's table but is
  the standard, audited choice; logged here.
- [phase3] Anonymous identity uses Hono's **signed cookie** (`chorala_uid`, signed with
  CHORALA_AUTH_SECRET, SameSite=None+Secure for cross-site widgets). Reads resolve identity
  without creating; writes (`requireEndUser`) create an anon end-user + set the cookie.
- [phase3] Public API auth/CORS/rate-limit live in one `publicProject` middleware: resolves
  project by `X-Chorala-Key`, enforces per-project `allowed_origins` CORS (echo origin or 403;
  `*` allowed), then a Redis fixed-window rate limit keyed by project+IP+minute. Rate limit
  **fails open** if Redis is down (graceful degradation, SPEC §2).
- [phase3] `POST /vote` and `DELETE /vote` map to an explicit `votes.setVote(..., shouldVote)`
  (idempotent add/remove) rather than a blind toggle, matching SPEC §8.2's two verbs. Votes
  always land on the canonical (post-merge) post → cross-language/duplicate ideas accumulate.
- [phase3] Localization is an overlay: the public feed fetches `post_translations` for the
  requested locale and swaps title/body, exposing `displayLocale`; original otherwise. This
  is what lets a French and Spanish user vote on the **same** canonical idea (SPEC §1/§11).
- [phase3] New public posts get the project's first `open`-kind status; embed/dedup/translate
  job enqueue is a marked TODO until the worker exists (Phase 6).
- [phase3] Public API integration tests run in-process via `app.request` against the seeded
  `acme` project (signs real JWTs with jose); they add a little data to that project per run
  (acceptable — seed is re-runnable).

## Phase 4
- [phase4] The widget (`@chorala/widget`) is fully **standalone** — depends only on `preact`,
  defines its own response types, and imports no `@chorala/*` packages. This keeps the MIT
  embed surface from importing the AGPL `@chorala/types` (resolving the §3/§5 vs CLAUDE.md
  tension in favor of "MIT must not import AGPL") and keeps the bundle tiny/self-contained.
- [phase4] Bundled with **tsup** (esbuild) → a single IIFE `widget.js` with Preact inlined.
  Result: 30KB raw / **11.6KB gzip** (target <40KB). Loader is **365B** (target <2KB).
- [phase4] Rendered into a **Shadow DOM** root with all CSS scoped inside (`:host { all: initial }`
  + class-prefixed rules). Verified in a real browser (Playwright): hostile host CSS
  (`* { color: crimson !important; font-family: Comic Sans !important }`, lime buttons) does
  not penetrate, and widget styles do not leak out.
- [phase4] The widget derives the public API base from its own `<script src=".../widget.js">`
  origin (override via `init({ apiUrl })`), so a host only pastes the snippet + project key.
- [phase4] API serves the built bundle at `/widget.js` (ACAO `*`, cached) by reading
  `packages/widget/dist/widget.js`; falls back to an error stub if not built. It also serves
  the demo at `/widget-demo.html` (dev convenience; the page also ships in the dashboard).
- [phase4] Two Biome a11y rules (`noStaticElementInteractions`, `useKeyWithClickEvents`) are
  disabled only for `mount.tsx`'s modal backdrop (standard dismiss-on-backdrop pattern); a
  real Escape-to-close handler + the keyboard-focusable × button preserve accessibility.
  `widget-demo.html` is excluded from Biome (it intentionally uses `!important` host CSS).

## Phase 5
- [phase5] Dashboard pinned to **Next 15.5.19** + **React 19** (SPEC §4 locks Next major 15;
  16 is out). Tailwind 4 via `@tailwindcss/postcss`.
- [phase5] Used hand-built shadcn-style Tailwind components (`components/ui.tsx`, CVA variants)
  instead of running the shadcn CLI / Radix — keeps the dependency surface small and the build
  fast while matching the shadcn look. Logged as a deviation from SPEC §4's "shadcn/ui".
- [phase5] The dashboard is **server-component-first**: pages call `@chorala/core` services
  directly (it's an AGPL server app) and mutations are **server actions** (`lib/actions.ts`)
  that resolve the session→AuthContext and call core, then `revalidatePath`. No HTTP round-trip
  to the API for admin data.
- [phase5] Auth: the dashboard runs its own Better Auth instance with the **same secret + DB +
  cookie scheme** as the API. On the shared host `idea.2pu.net`, sign-in POSTs to the API's
  Better Auth (haproxy routes `/api/*` → :8787), which sets the session cookie; the dashboard
  (:3015) reads it. Both key `useSecureCookies` off `CHORALA_PUBLIC_URL`'s scheme so the cookie
  name/flags match across backends — without this the dashboard looked for a differently-prefixed
  cookie and never saw the session (caught + fixed via Playwright). Note: this means admin auth
  works on the shared host, not across distinct localhost ports.
- [phase5] Public portal lives under `/portal/[projectId]`, server-rendered from `publicFeed`,
  themed by the project's `widgetSettings.primaryColor`; portal voting calls the public API
  client-side with the project key (same-origin on idea.2pu.net).
- [phase5] E2E: a committed Playwright spec (`apps/dashboard/e2e/journey.spec.ts`) drives the
  full SPEC §13 journey against a live stack (BASE_URL, default idea.2pu.net) — **passes**.
  Also verified interactively via the Playwright MCP (real Chromium).
- [phase5] Biome: excluded `*.css` (Tailwind 4 at-rules aren't parseable by Biome's CSS parser)
  and disabled `a11y/noLabelWithoutControl` for the dashboard (reusable Label component).

## Phase 6
- [phase6] `packages/ai`: `LLMProvider` interface + Ollama/OpenAI/Anthropic/Noop providers
  (plain `fetch`, no vendor SDKs → light deps) selected by a factory from env. Tasks
  (embed, dedup, translate, processPost, clusterThemes, summarize) are pure functions over
  (provider, db) so they're unit-testable with a mock provider.
- [phase6] AnthropicProvider.canEmbed = false (Anthropic has no embeddings API); `embed()`
  throws a clear message. Embedding dim is fixed at 768 (nomic-embed default, matches the
  schema's `vector(768)`); OpenAI users must pick a 768-dim model.
- [phase6] Dedup records a **suggestion** in `ai_jobs` (kind=dedup, result.suggestions) and
  never auto-merges (SPEC §11). pgvector cosine (`<=>`) finds candidates ≥ threshold.
- [phase6] Cross-language: `translatePost` writes `post_translations` (is_auto) for every org
  locale; votes already attach to the canonical post, so a localized view votes on the same row.
- [phase6] Queues (`packages/core/src/queues.ts`): BullMQ producers (ai/webhooks/email,
  prefix `chorala`) with `safeAdd` that **fails open** if Redis is down and **no-ops under
  NODE_ENV=test** (so unit tests don't open queue connections / hang Vitest). Lazy connection.
- [phase6] `apps/worker`: BullMQ workers — AI (processPost/clusterThemes/summarize via the
  env provider), webhooks (HMAC `X-Chorala-Signature`, BullMQ retries/backoff), email. Core
  services enqueue on the right events (post.created→AI+webhook, status_changed, merged,
  comment.created, vote.created, changelog.published).
- [phase6] `packages/email`: pluggable transport (SMTP via nodemailer / Resend via fetch /
  Noop) + HTML template builders. Used plain HTML builders rather than React Email components
  to keep deps light; email is Noop on this host. Logged as a deviation from SPEC §11.
- [phase6] Verified: AI task chain + Noop degradation via Vitest mock provider (5 tests);
  live worker boots and consumes an enqueued job end-to-end (producer→Redis→worker→transport).

## Phase 7
- [phase7] `packages/mcp` (MIT) is a **standalone HTTP client** of the Chorala admin API
  (Bearer `hk_…` key) — it imports `@modelcontextprotocol/sdk` + `zod` only, never the AGPL
  server code, honoring SPEC §3's "MIT must not import AGPL". It defines its own minimal types.
- [phase7] To back the AI-powered MCP tools, added a small admin API surface
  (`apps/api/src/routes/ai.ts`, mounted before `/posts/:id` so `/posts/search` wins):
  `GET /posts/search` (semantic via pgvector, text fallback when AI off), `POST
  /posts/:id/summarize`, `POST /changelog/draft`. Core gained `posts.semanticSearch`; AI
  gained `draftChangelogFromPosts`. The api now depends on `@chorala/ai`.
- [phase7] 9 tools: list_boards, list_posts, get_post, search_feedback, top_requests,
  cluster_themes, summarize_post, update_post_status (resolves status by name), and
  draft_changelog_from_posts. The api key is project-scoped, so the server resolves its
  single project via `GET /projects` and caches the id.
- [phase7] Transports: stdio (default, for local Claude clients) + streamable HTTP
  (`CHORALA_MCP_TRANSPORT=http`). README ships the exact Claude Desktop / Claude Code config.
- [phase7] The MCP test (`test/stdio.test.ts`) spawns the server and drives it with the real
  MCP SDK client over stdio; **skips cleanly** (exit 0) without `CHORALA_MCP_API_KEY` so it
  doesn't break `pnpm test`. Verified live: 9 tools; search_feedback + top_requests return
  seeded data.

## Phase 8
- [phase8] `packages/billing` (AGPL): plans (free/starter/pro by **admin-seat** count — never
  user/vote metering, SPEC §1/§12), `assertSeatAvailable` (wired into member invites; no-op in
  self-host), and Stripe checkout + webhook handlers. Stripe is **lazy-imported** so self-host
  never loads it; the whole module is inert unless `CHORALA_DEPLOYMENT=cloud`. Verified inert.
- [phase8] Docker: real multi-stage-ish Dockerfiles for api/worker (run TS source via tsx) and
  dashboard (next build → next start); `Caddyfile` routes `/api/*` + `/widget.js` → api, else →
  dashboard; `docker-compose.yml` runs postgres(pgvector)+redis+api+worker+dashboard+caddy with
  only Caddy publishing 80/443 (pg/redis internal). API runs migrations on boot.
- [phase8] Did NOT use turbo-prune per-service pruning; each image does a full workspace
  `pnpm install` (simpler, correct; prune is a future image-size optimization). Logged.
- [phase8] Full `docker compose up` was NOT executed on this dev host because it already binds
  :80 (haproxy), :5432 and :6379 (shared PG/Redis) — bringing the stack up would collide. Instead
  verified: `docker compose config` is valid (6 services) and the worker image **builds end to
  end**; the three apps were run live throughout (api/dashboard/worker) against shared PG/Redis.
- [phase8] CI (`ci.yml`): install → lint → build → db:migrate → db:seed → test, with pg+redis
  service containers and AI/email set to none.
- [phase8] README expanded: one-command self-host, local dev, widget embed, end-user JWT/SSO,
  MCP, env reference, cloud-vs-selfhost, architecture, licensing, contributing.

## Design pass
- [design] Gave the dashboard + portal a distinctive **"editorial paper"** identity (warm
  off-white canvas + grain/gradient, near-black warm ink, a single confident **vermilion**
  accent fitting for upvotes) — deliberately away from the generic indigo/purple-on-white
  SaaS look. Display font **Fraunces** (serif, optical sizing) for the wordmark + page titles;
  **Hanken Grotesk** for UI, via `next/font`.
- [design] New token system in `globals.css` (`--color-paper/raised/ink/line/accent…`), with
  `brand-*` repointed to the accent so existing utilities recolor instantly; refined `ui.tsx`
  primitives (buttons w/ inset highlight + accent ring, fields, cards via `.surface`, badges
  with status dots), a signature tactile **VotePill**, an icon'd active-state sidebar nav,
  redesigned login (oversized decorative wordmark), polished portal + kanban roadmap.
  Widget keeps its own per-project theming. Verified visually via Playwright.

## Themes + responsive
- [design] Added a 5-theme system (Paper, Midnight/dark, Forest, Cobalt, Mono) as pure CSS
  custom-property swaps under `:root[data-theme]` — every surface re-skins instantly because
  the whole UI is var-driven. A header theme picker (swatches) persists to a cookie +
  localStorage; the root layout reads the cookie for SSR so there's no flash. Theme metadata
  lives in `lib/themes.ts` (a plain module) — importing a value from a `'use client'` file into
  a server component yields a client *reference*, not the array (caused a crash; fixed).
- [design] Responsive pass: the project sidebar is desktop-only, so mobile gets a sticky
  horizontal scrollable nav bar; post-list rows wrap their pin/status controls onto their own
  line on phones and the status select is width-capped. Verified on desktop (1366) and mobile
  (390) via Playwright across posts, post detail, and theme switching.
- [phase10] Bug-report attachments use a **local-disk store** (`CHORALA_UPLOAD_DIR`, an absolute
  path shared by API + dashboard) over object storage — simplest path consistent with the
  "`docker compose up` self-host" goal (SPEC §2/§5). Cloud can swap the driver later.
- [phase10] Screenshots upload as a **base64 data URL in JSON** (`POST /public/attachments`)
  rather than multipart — avoids a body-parser dependency and keeps the widget→API contract a
  single zod schema. Per-file (5 MB) + per-project (1 GB) byte limits guard against abuse.
- [phase10] Uploaded bytes are **admin-only** (like the submission `context`): never on the
  public post payload; served through an auth-gated dashboard route (`/admin-media/[id]`) so the
  shared on-disk store is never publicly reachable. Only `appVersion` stays first-class/public.
- [phase10] The widget surfaces the screenshot control **only on `kind=bug` boards**; the
  auto-collected `context` map (browser/os/url/locale/screen) is attached to every submission.
- [phase11] Revenue impact = Σ MRR of the **distinct companies** whose users voted (not Σ over
  voters), so a 3-seat account counts its MRR once. Computed as a correlated SQL subquery on the
  posts list, exposed as `revenueImpact` alongside (never replacing) `voteCount`.
- [phase11] Company filters on the posts list (`companyId`/`plan`/`minMrr`) match the **post
  author's** company (the segment that *asked*), while revenue impact aggregates **voters'**
  companies (the demand behind it) — two different, intentional lenses.
- [phase11] In a correlated subquery used inside a SELECT projection, the outer column must be a
  literal `"posts"."id"` / `"companies"."id"` — drizzle renders an interpolated `${table.id}`
  unqualified there (qualified only in WHERE/ORDER BY), which collides with the inner tables' own
  `id` columns ("column reference id is ambiguous"). Verified live before shipping.
- [phase12] Scoring is **additive weighted** (score = Σ value×weight), not RICE's multiplicative
  reach×impact×confidence/effort. A data‑driven weighted sum keeps the engine a tiny per‑project
  field table + JS reducer (no formula parser), and models RICE/ICE ordering well enough via
  negative weights for cost inputs (Effort = −1). Score is computed in app code, not SQL, since a
  project's field set is small and the list isn't paginated.
- [phase12] `sort=score` sorts in JS after fetch (the score is computed in app code); all other
  sorts stay in SQL. Acceptable because the admin list returns a whole project's posts unpaginated.
- [phase12] Company/plan/minMrr filters target the **author's** company; `revenueImpact` aggregates
  **voters'** companies — kept from Phase 11. Score `fields` + `assignee` live on `adminPostColumns`
  (admin‑only), never on the public‑safe `postColumns`.
- [phase12] **Deferred** saved‑views and a generic rules/automation engine from this phase — they
  are the heaviest, least‑cohesive pieces and the worker already handles status‑change side effects.
  Revisit when there's demand; recorded here so the cut is explicit, not silent.
- [phase13] A segment is a saved predicate over `end_users` left-joined to `companies`, compiled
  to SQL from a fixed field whitelist (plan/mrr/locale/email_domain/has_company) + op whitelist
  (eq/neq/gt/gte/lt/lte). Operators come from a `sql.raw` whitelist and values are parameterized
  (`${}`), so the dynamic predicate can't be injected. Empty rules ⇒ `true` (everyone).
- [phase13] Targeted changelog notifies the segment's **end_users with an email**; untargeted
  keeps the existing **changelog_subscribers** path. `recipient_count` records actual reach. Both
  paths run `{{var}}` substitution per recipient (renderVars), so personalization works either way.
- [phase13] **Deferred** segment-restricted roadmap/board visibility (it would push per-request
  segment evaluation onto the public read path) and email open/click pixel analytics (needs a
  tracking endpoint + image beacon). Recorded so the cut is explicit. Segments are reusable for
  these later — the resolver already returns the matching end-users.
- [phase14] Autopilot is built around a generic `POST /ingest` (raw text + source) rather than
  per-vendor OAuth. `extractFeatureRequests` returns the requests; the API route creates a
  `pending` post per request. Real Intercom/Zendesk/Slack connectors are thin webhooks that POST
  to `/ingest` — deferred for the same reason GitHub OAuth was (external app registration +
  credentials we can't self-provision). The endpoint IS the connector contract.
- [phase14] AI-ingested posts land in `review_status='pending'` (hidden from the public board AND
  the default admin list) and require human approval → `none` (live) or `dismissed`. Never
  auto-published — matches the SPEC "suggest, don't auto-act" stance (cf. dedup §11).
- [phase14] Graceful degradation: with AI off, `extractFeatureRequests` captures the whole
  conversation as ONE request (so ingest still works) and `askFeedback` returns a keyword match
  with no synthesized answer. AI only upgrades extraction (multi-request) + ask (synthesis).
- [phase14] `extractFeatureRequests`/`askFeedback` live in `@chorala/ai`; post creation + review
  lifecycle in `@chorala/core`; the API route (which already imports both) glues them — so no new
  core→ai dependency. The dashboard does take @chorala/ai for the ingest/ask server actions.
- [phase14] **Deferred**: AI auto-categorization to a board (ingest lands on the first feature
  board) and AI smart-reply drafting. The clustering/embedding pipeline already runs on ingested
  posts, so these are additive later.
- [phase15] Integration breadth shipped the two pieces buildable+testable WITHOUT external OAuth:
  a Segment-compatible **inbound webhook** (`/inbound/:projectId`, Bearer = per-project secret →
  identify/group upsert end-users+companies) and **Discord outbound** (incoming-webhook URL).
  Jira/Intercom/Zendesk OAuth deferred (same blocker as GitHub OAuth — external app registration +
  creds we can't self-provision); /inbound + Phase-14 /ingest already cover inbound. Zapier/Make
  need no new code (they consume the existing webhooks + REST API).
- [phase15] The inbound webhook lives OUTSIDE admin auth (mounted before the admin cors/requireAuth),
  authenticated by its own per-project secret (generated by `setSegmentIntegration`, encrypted at
  rest, validated constant-ish via decrypt+compare). `integrations.type` widened to include
  discord+segment (text column $type only — no migration).
- [phase16] Surveys ship as a post‑v1 expansion past SPEC §1's "no surveys" non‑goal, but stay
  true to the flat‑pricing prime directive: NO per‑response/per‑seat metering. One response per
  end‑user enforced by a partial unique index `(survey_id, end_user_id) where end_user_id is not
  null`; the route returns 201 on a duplicate (onConflictDoNothing) rather than erroring, so the
  widget UX is idempotent. Anonymous visitors get a signed `chorala_uid` cookie → an end‑user row,
  so "once per user" holds without login. NPS = round((%promoters≥9 − %detractors≤6)); CSAT/CES
  top‑box = value ≥ scaleMax−1. AI is not required (surveys are deterministic aggregation).
- [phase16] First‑party CORS: the public middleware now auto‑allows the hosted portal origin
  (`CHORALA_PUBLIC_URL`) and a project's own `customDomain` in addition to its `allowedOrigins`.
  Without this, votes/comments/survey‑submits from the Chorala‑hosted portal (chorala.com/portal/…)
  or a custom feedback domain 403'd unless the customer hand‑whitelisted Chorala's own domains —
  which they can't know to do. These are first‑party surfaces we control, so allowing them is safe;
  third‑party origins still require explicit `allowedOrigins`.
- [phase17] "Custom admin roles" shipped as a single new `moderator` role rather than a full
  per-permission RBAC matrix — the simplest slice that delivers separation of duties (content
  moderation without org/billing/member control). `canModerate` = owner/admin/moderator (session)
  OR a write-scoped API key (so automation can moderate); `canManageOrg` stays owner/admin only.
  A richer custom-permission system can layer on later if demand appears.
- [phase17] Moderation flags but never auto-hides. A cheap deterministic spam heuristic
  (`detectSpam`: link-count, keyword list, all-caps, repeated-word) runs at public submit time and
  sets `flaggedReason` — the content STAYS VISIBLE and a human decides (Approve/Hide). Chosen over
  auto-hiding so false positives never silence real users, and over an AI classifier so it works
  with provider=none (this box). Hidden content (`hiddenAt`) drops from the public board, the
  single-post view, the roadmap and the comment count, but the row is retained for audit.
- [phase17] Audit log: `recordAudit` is best-effort (try/catch, never throws) so a logging failure
  can't break the mutation it records; called from core services (where `ctx` is available) after
  the change succeeds. Read access (`listAuditLog`) is restricted to `canManageOrg` OR API-key
  callers; a plain `member` session cannot read it. Actor is the session userId (resolved to
  name/email via a left join) or `apikey:<projectId>` for automation.
- [phase17] **Deferred**: SAML/SCIM admin SSO — it requires registering an app in an external IdP
  (Okta/Azure AD/Google Workspace) and credentials we can't self-provision in this environment,
  same blocker as the OAuth integrations. Better Auth has a SAML/SSO plugin path to slot in later.
- [phase19] Analytics is 100% deterministic SQL aggregation (counts, window deltas, board-health
  rollups, revenue-impact via distinct voter-company MRR), NOT AI. This makes the whole dashboard
  work on this box where the AI provider is `none`; AI cluster themes are shown when the Phase-6
  worker has produced them but are never required. "Sentiment" (the one AI-flavoured item in the
  Phase-19 roadmap entry) is deferred to Phase 20 (AI depth) rather than faked.
- [phase19] Insight linking ("quotes → features", Productboard's wedge) shipped as a first-class
  `insights` table (quote + source + customerEmail + optional companyId, FK to post). It powers a
  "most evidenced" analytics ranking — demand measured by who-said-what + account MRR, not just raw
  votes. Kept admin-only (no public surface) and flat-priced (no per-insight metering).
- [phase19] Report export is CSV only for now (`?format=csv`, mirroring the existing posts CSV +
  a Next route handler for the dashboard download button). PDF is deferred — it needs a rendering
  dependency and CSV already covers "pull the numbers into a deck/sheet"; revisit if asked.
- [phase20] Every Autopilot-v2 feature has a deterministic fallback so it works (and is
  testable/demoable) with provider=none, the state on this host. Sentiment uses a feedback-tuned
  lexicon (tanh-squashed word counts → −1..1 + 3-way label); auto-categorize matches the project's
  existing tag names as whole words; smart-reply is a templated reply from title/status/votes;
  the weekly digest is composed from SQL aggregates. The LLM, when configured, *refines* each
  (sentiment re-scored in the worker pipeline, suggest-tags/draft-reply/digest-narrative via
  complete()) — it never gates the feature. Keeps SPEC §2 graceful-degradation + no per-credit tax.
- [phase20] Sentiment is computed SYNCHRONOUSLY at post-create time in core (cheap, no network) so
  every post is scored even when AI is off and the worker pipeline (gated on isAiEnabled) never
  runs. This required core → @chorala/ai (acyclic: ai depends only on db+config). Stored as
  posts.sentiment + posts.sentiment_label (migration 0011); existing rows backfilled with the
  lexicon.
- [phase20] Auto-tagging applies only the project's EXISTING tags (never invents new ones) and is
  additive + idempotent — safe to run on every submit. Board auto-assignment was NOT built: the
  public submit form already picks a board, and silently moving posts between boards is the kind of
  surprising automation SPEC warns against (cf. never auto-merge). suggest-tags is the AI upgrade.
- [phase20] The weekly digest runs as a BullMQ repeatable job (cron '0 8 * * 1', registered once at
  worker startup) that emails org owners/admins — but only when the email transport is configured;
  with transport=none it logs. The digest BUILDER is verified via GET /digest/preview + tests; the
  cron firing itself isn't unit-tested (BullMQ scheduling is infra, not our logic).

## 2026-10-25: owned Satflux fork dependency maintenance

Keep SPEC's Next 15 and Vitest 3 major lines while applying compatible security
patches. Next 15.5.28, Better Auth 1.6.33, Sharp 0.35.5, Zod 4.6.7 and MCP SDK
1.32.2 replace the inherited vulnerable versions. Nodemailer moves to 10.1.7
because its recipient-parser fixes require the newer line; the existing unpooled
SMTP API is retained and tested with synthetic loopback submission, authentication
and rejection. No-op email diagnostics contain no message or recipient data.

Pinned pnpm overrides patch runtime transitives within their existing majors.
Vitest 3.2.7 uses Tinypool 2.1.2: Tinypool's major change removes Node 18 support,
while this fork uses Node 24. Validate both fork and thread pools. Do not force
Vitest 4's mocker into Vitest 3 or silently amend SPEC to hide an audit finding.
All transitive PostCSS copies are explicitly pinned to the patched 8.5 line.
Build tools also receive patched js-yaml 4 and brace-expansion 2. The scoped
`esbuild@^0.27.0` override moves tsup to 0.28.1, whose pre-1.0 breaking change is
fallback binary-download integrity verification. Rebuild and browser-test the
widget; preserve Drizzle's unrelated legacy esbuild instead of forcing a global
cross-version override.

MCP HTTP requires independent caller authentication before SDK creation/parsing,
defaults to loopback and uses per-request stateless transports. Explicit SDK tool
element and HTTP body budgets are required; upgrading the SDK alone does not enable
the allocation defense. Stdio remains the default. See `docs/MCP_SECURITY.md`.

Upload decoding validates raster signatures before Sharp, then uses actual native
decoding, dimensions and quotas. Two historical synthetic PNG test literals had an
invalid IDAT CRC and truncated deflate stream. Replace those fixtures with a valid
generated one-pixel PNG; do not weaken the decoder to accept corrupt input.

CI fails on full-audit high/critical records, including build tools. Residual moderate findings and
the exact inactive entry points are tracked in `docs/DEPENDENCY_SECURITY.md`, rather
than suppressed or represented as a clean audit. Reassess when dependencies,
development-server configuration or application imports change.

## Changelog republication dates (2026-10-27)

- [changelog] Retain an existing `publishedAt` when a previously published entry
  returns from draft to published. Fill it only on first publication, inside the
  existing project-scoped row lock. Editing and republishing must not silently
  move an entry's release chronology. `displayDate` remains the explicit calendar
  override; clearing it intentionally uses the retained timestamp fallback.
- [changelog] Preserve existing publication-transition notification/webhook rules
  and the non-atomic database/queue boundary. A later explicit republication can
  still deliver again; date-only edits do not. Do not rewrite existing timestamps,
  reimport history, change content or republish production data to apply this fix.
- [changelog] The earlier display-date migration and matching widget remain
  required for renamed imported history. This follow-up adds no migration,
  dependency or client artifact change. Prepare the owned provider PR with
  independent regression/security evidence; merge and deployment remain owner
  decisions.
