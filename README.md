# Chorala

This is **webiumsk's independently maintained fork for Satflux feedback**, based on
upstream `2ge/chorala` at `6cb0cc7`. The hosted `chorala.com` service is not required.
See [fork scope and validation](docs/FORK_SCOPE.md) and the
[self-hosting guide](docs/SELF_HOSTING.md). Existing project features remain available;
this fork does not introduce a separate hosted product. Original licenses and notices apply.

> **Chorala** is an open-core, embeddable, multilingual, AI-native product-feedback
> platform — a self-hostable alternative to Canny / Featurebase / Frill.
>
> **We never charge you for your users voting.** Cloud pricing is flat per-admin;
> end-users and votes are always unlimited.

**Chorala** is the product (chorala.com). Internally the code keeps the `@chorala/*` package
scope and `CHORALA_` env prefix as stable identifiers (not user-visible).

- **The whole loop** — feedback boards with voting + comments, a public roadmap, and a
  changelog that emails every voter the moment an idea ships. Statuses, tags, merge & dedup.
- **AI Autopilot** — paste a support thread and AI extracts the feature requests as drafts
  for review; "ask your feedback" in plain English; dedup, clustering & summaries. Pluggable
  provider (Ollama default; OpenAI/Anthropic optional; degrades cleanly to off — no AI tax).
- **Revenue-weighted prioritization** — sync companies + MRR (via the identify JWT or an
  inbound CDP webhook) and see the dollars behind every request; filter by plan / company / MRR.
- **Audience segments + targeted changelog** — build segments from any attribute and announce
  only to the people an update is for, personalised with `{{first_name}}` / `{{company}}`.
- **Weighted scoring & triage** — custom numeric fields → RICE/ICE-style scores, CSV export,
  vote-on-behalf, owner assignment. **Bug capture**: annotated screenshots + auto browser context.
- **Embeddable everywhere** — a tiny Preact widget in a Shadow DOM (zero CSS leakage), a hosted
  portal on your custom domain, **multilingual** (same canonical idea across languages).
- **Developer-first** — typed SDK from an OpenAPI 3.1 spec, self-discoverable API (RFC 8631/9727
  + llms.txt), signed webhooks, GitHub & Discord, and a native **MCP server** for Claude / Cursor.
- **Open source (AGPL core, MIT widget/SDK/MCP) + managed cloud** — self-host with one command.

## Quick start

### Self-host

```bash
cp .env.example .env
# Configure independent random CHORALA_AUTH_SECRET and CHORALA_DB_PASSWORD,
# owned public URLs, and explicit initial-administrator credentials.
docker compose config --quiet
docker compose up -d --build
```

Caddy serves the stack on `:80` (set `CHORALA_DOMAIN=feedback.example.com` in `.env` for
automatic HTTPS). A one-shot migration service runs before the API. Create the first
administrator on a fresh installation with:

```bash
docker compose exec api pnpm --filter @chorala/api seed:admin
```

Set `CHORALA_BOOTSTRAP_EMAIL`, `CHORALA_BOOTSTRAP_PASSWORD` (16-128 characters) and
optionally `CHORALA_BOOTSTRAP_NAME` in the protected environment first. Remove the
bootstrap password after success. Bootstrap refuses existing accounts and never
resets them. Demo seeds are destructive test fixtures and must not be used in production.
Public self-host signup is disabled by default. Follow the self-hosting guide for
controlled staff onboarding, persistent attachments and backup/restore.

### Local development with disposable data

```bash
pnpm install
docker compose up -d postgres redis             # or use your own PG16 + Redis
pnpm db:migrate && pnpm db:seed
pnpm dev                                         # api :8787, dashboard :3015, worker
```

The demo database seed does not provision a production administrator credential.
Use a fresh disposable database and the explicit bootstrap command when testing login.
Open the dashboard (`:3015`) and load the widget demo at
`http://localhost:8787/widget-demo.html?key=<publicKey>`.

## Architecture

```
apps/        api (Hono :8787) · dashboard+portal (Next 15 :3015) · worker (BullMQ)
packages/    db (Drizzle+pgvector) · core (domain services) · ai (LLM providers + tasks)
             email · billing (Stripe, cloud-only) · config · types          (AGPL)
             widget · mcp · sdk-react-native (stub)          (MIT)
docker/      Dockerfile.{api,dashboard,worker} · Caddyfile
```

- **Type-safe end to end**: shared zod schemas in `packages/types` are the API contract.
- **Thin routes → core services → DB**: domain logic lives in `packages/core` and is
  shared by the API, worker, and dashboard.
- **Graceful degradation**: if AI/email isn't configured, those features are *disabled*,
  never broken.

## Widget embed guide

One tag — the floating widget self-configures from `data-*` attributes:

```html
<script async src="https://feedback.example.com/widget.js" data-chorala-key="pk_live_xxx"></script>
```

Optional: `data-mode` (`floating`|`inline`|`manual`), `data-locale`, `data-view`
(`board`|`roadmap`|`changelog`), `data-color`, `data-app-version` (stamped on every
submission as a filterable `appVersion`).

Submissions auto-carry browser/OS/URL/locale/screen context (no host config), and **bug
boards** offer screenshot capture + redact/highlight annotation.

SSO is still one tag — pass the signed JWT as `data-jwt`:

```html
<script async src="https://feedback.example.com/widget.js"
        data-chorala-key="pk_live_xxx" data-jwt="eyJhbGci…"></script>
```

If the JWT is computed in JS, set `window.choralaSettings = { projectKey, user: { jwt } }`
before the script instead. Inline embeds and runtime control use the `Chorala(cmd, …)` API:
`init`, `identify(user)`, `open(view?)`, `close`, `render(selector, {view})`, `on(event, cb)`.

## End-user identity (SSO)

To identify your logged-in users (so votes are attributed and dedup'd), sign a JWT with
the project's **end-user JWT secret** (Project → Settings) using HS256:

```ts
import { SignJWT } from 'jose'
const token = await new SignJWT({ id: user.id, email: user.email, name: user.name, segment: { plan: 'pro', mrr: 4200 } })
  .setProtectedHeader({ alg: 'HS256' }).setIssuedAt().setExpirationTime('1h')
  .sign(new TextEncoder().encode(END_USER_JWT_SECRET))
```

Pass it to the widget: `Chorala('init', { projectKey, user: { jwt: token } })`. Anonymous
visitors fall back to a signed cookie. `segment` powers prioritization (e.g. weight votes
by MRR). Mirrors Canny/Featurebase SSO.

## API

- **Interactive reference:** `/docs` (e.g. `https://chorala.com/docs`) — a Scalar UI with
  "try it out" and client-library snippets.
- **Machine-readable spec:** `/api/v1/openapi.json` — OpenAPI 3.1, generated from the zod
  contract; feed it to SDK generators / Postman.
- **Prose reference:** **[`docs/API.md`](docs/API.md)** — auth model, conventions, every
  endpoint, webhooks and the embed JS API.

All three are generated from / mirror the single zod contract in `packages/types`.

## MCP (triage from Claude / Cursor)

See [`packages/mcp/README.md`](packages/mcp/README.md). Create an `hk_…` key in
Project → API keys and register the server (stdio or streamable HTTP) — 9 tools incl.
`search_feedback`, `top_requests`, `summarize_post`, `draft_changelog_from_posts`.

## Environment

All vars are documented in [`.env.example`](.env.example). Required: `DATABASE_URL`,
`CHORALA_AUTH_SECRET`. Key optional groups: AI (`CHORALA_AI_PROVIDER` + model/base-url),
email (`CHORALA_EMAIL_TRANSPORT`), billing (`STRIPE_*`, cloud only), widget/public API
(`CHORALA_WIDGET_CDN_URL`, `CHORALA_RATE_LIMIT_PUBLIC`). `packages/config` zod-validates at
boot and fails fast on a missing required var.

## Cloud vs self-host

`CHORALA_DEPLOYMENT=selfhost` (default): no Stripe, no caps, unlimited admins.
`CHORALA_DEPLOYMENT=cloud`: Stripe billing + public signup + **admin-seat** limits per plan
(free/starter/pro). End-users and votes are **always unlimited** — never metered.
Billing code is fully inert in self-host.

## Scripts

`pnpm dev | build | lint | format | test | test:e2e | db:generate | db:push |
db:migrate | db:seed` — all wired through Turborepo.

## Licensing

Mixed open-core layout (see [`NOTICE`](NOTICE)):

- **AGPL-3.0** — repo root + server code (`apps/*`, `packages/{db,core,ai,email,billing,config,types}`). See [`LICENSE`](LICENSE).
- **MIT** — the embed/SDK/MCP surfaces (`packages/{widget,mcp,sdk-react-native}`),
  each with its own `LICENSE`, so companies can embed them without AGPL obligations. These
  packages import no AGPL code.

## Contributing

Sign the [CLA](CLA.md) (one click on your first PR). `pnpm install && pnpm build &&
pnpm lint && pnpm test` must pass. Judgement calls made while building are logged in
[`DECISIONS.md`](DECISIONS.md).

## Status / intentionally stubbed

- `packages/sdk-react-native` is a README-only stub (no native mobile SDK in v1).
- v1 integrations: Slack, Linear, GitHub, generic webhooks (webhook delivery is live;
  the Slack/Linear/GitHub specifics are scaffolded).
- AI features require a configured provider; with `CHORALA_AI_PROVIDER=none` they're cleanly disabled.
