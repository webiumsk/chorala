# Dependency security review

The initial owned-fork graph reported six critical and 32 high advisory records.
The patched lockfile reports **zero critical, zero high, four moderate and zero
low records** in production and full audits on 2026-10-25. Records are not the same
as distinct vulnerabilities: one Vitest advisory appears against two packages.
CI runs `pnpm audit --audit-level high` without advisory suppressions. The full audit
also covers patched build-tool dependencies (PostCSS, js-yaml, brace-expansion and
tsup's scoped esbuild); production-only auditing would have missed those paths.

## 2026-10-27: Better Auth upgrade qualification

Fresh CI for changelog follow-up `362070b` reports newly published advisories
against the existing Better Auth 1.6.33 pin before build/test steps. Upgrade both
API and dashboard together to 1.7.7, retaining the existing full high/critical
audit gate. The lock update is limited to the Better Auth package family and its
required `@better-fetch/fetch` patch; application auth policy and schema are unchanged.

- [GHSA-965c-763c-88jm](https://github.com/better-auth/better-auth/security/advisories/GHSA-965c-763c-88jm)
  and [GHSA-r4xp-prcw-77qf](https://github.com/better-auth/better-auth/security/advisories/GHSA-r4xp-prcw-77qf)
  are fixed in 1.7.7. Their Magic Link/OAuth Proxy prerequisites are not enabled by
  the reviewed API/dashboard configuration; that does not remove the package
  audit findings or establish the deployed configuration.
- [GHSA-q84f-53jg-9ppm](https://github.com/better-auth/better-auth/security/advisories/GHSA-q84f-53jg-9ppm)
  requires the opt-in Device Authorization plugin, also absent from this source.
  Version 1.7.7 includes the earlier fix.
- The [pinned upgrade guide](https://github.com/better-auth/better-auth/blob/v1.7.7/docs/content/docs/guides/1-7-upgrade-guide.mdx)
  restores the 1.6 core account schema after the transient 1.7 issuer requirement.
  Direct 1.6.33-to-1.7.7 use of our four core models needs no new column/backfill,
  password conversion or mandatory session-token hashing migration. Keep the new
  runtime schema validation enabled and verify actual legacy login/session flows.
- Duplicate `(providerId, accountId)` records now fail closed. Before an approved
  production update, check this data-integrity condition without exposing account
  contents. Do not automatically delete or rewrite credentials as part of the upgrade.

The fresh full candidate audit has zero high/critical/low findings and five
moderate records already present in the current baseline. This supersedes the
dated October 25 count above, not the existing moderate-advisory exposure limits.
Frozen-install, compatibility, independent-review and exact-head CI evidence are
recorded separately; package metadata alone is not runtime acceptance.

The isolated candidate passes frozen installation, all 20 workspace typecheck
tasks, all 15 production build tasks and Biome with the six inherited warnings.
Independent HTTP and HTTPS-cookie probes accept actual 1.6.33 password hashes,
accounts, session cookies and password-reset tokens through the new API and
dashboard. They also retain closed signup, trusted-origin checks, bootstrap
refusal on an occupied installation, the explicit first-owner setup hook and
Satflux's one-hour signed identity. The auth-table column metadata is unchanged.
Tokens, passwords and hash values are kept out of logs; only synthetic databases
are used. External OAuth provider delivery and production duplicate-account
checks remain operator work, not claimed test results.

No additional auth migration is needed for this dependency update. The separate
changelog `displayDate` migration `0012` in the same PR still belongs to the
provider-first rollout; do not skip it based on the auth compatibility result.

## Residual moderate advisories

| Advisory | Installed path and required exposure | Current disposition |
| --- | --- | --- |
| [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) | Drizzle's legacy esbuild loader; exposure requires esbuild's development HTTP server, including loopback through browser CORS | The loader transforms owned configuration. Production entry points do not call `esbuild.serve()`. Never start this legacy development server, including on localhost. |
| [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) | Two records, for Vitest and its mocker; reachable development mock-registration WebSocket/browser RPC | Tests use `vitest run`, not UI/watch/browser RPC. No non-test application entry point imports Vitest. Better Auth references it only from the separate test-utils entry. Do not expose mock/UI/HMR test servers. |
| [GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) | Vitest mocker plugin registered on a reachable Vite HMR server | No direct mocker/interceptor plugin registration in the application. Node test runs do not install that handler. Do not add an exposed mock server without resolving this advisory first. |
| [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) | MCP SDK's transitive Express helper includes qs 6.16.0; the sink requires nondefault comma-array `qs.stringify` with attacker-shaped elements | The reviewed MCP HTTP entry uses native Node HTTP plus SDK Streamable HTTP/Hono, not its Express helper. Query serialization uses typed primitives and URLSearchParams; no comma-array stringify sink is registered. Reassess or patch to 6.16.1 before adding such untrusted serialization. Query parsing alone is not this sink. |

SPEC pins Vitest 3; these mocker fixes currently require Vitest 4.1.12 or later.
Keep the residual visible, retain the patched Tinypool override and use isolated
test environments with synthetic credentials. A future test-runner major upgrade
requires its own compatibility review. No cross-major mocker override is applied.

Production commands start Hono, Next's production server and the worker. They do
not start Vitest, Vite UI or esbuild's development server. Package presence in an
audit graph does not prove a reachable endpoint, and this assessment is not a claim
that the entire dependency tree is free of vulnerabilities.

## Runtime checks

The patched graph must pass frozen-lockfile installation, typecheck, lint, build,
default Vitest fork pools and a separate thread-pool run. Real SDK HTTP tests cover
caller authentication and allocation budgets. Real synthetic SMTP tests cover the
Nodemailer major update. Rebuilt production images must exercise existing-account
login, feedback Server Actions, static raster attachments and scoped MCP access.
Keep final evidence in `FORK_SCOPE.md`; results from earlier images are historical.

External provider delivery, real TLS/DNS and historical hosted data migration are
separate staging/deployment work. The generic webhook delivery path still needs an
egress/SSRF/redirect review before untrusted destinations are enabled.
