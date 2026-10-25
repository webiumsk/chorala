# Dependency security review

The initial owned-fork graph reported six critical and 32 high advisory records.
The patched lockfile reports **zero critical, zero high, four moderate and zero
low records** in production and full audits on 2026-10-25. Records are not the same
as distinct vulnerabilities: one Vitest advisory appears against two packages.
CI runs `pnpm audit --audit-level high` without advisory suppressions. The full audit
also covers patched build-tool dependencies (PostCSS, js-yaml, brace-expansion and
tsup's scoped esbuild); production-only auditing would have missed those paths.

## Residual moderate advisories

| Advisory | Installed path and required exposure | Current disposition |
| --- | --- | --- |
| [GHSA-67mh-4wv8-2f99](https://github.com/evanw/esbuild/security/advisories/GHSA-67mh-4wv8-2f99) | Drizzle's legacy esbuild loader; exposure requires esbuild's development HTTP server, including loopback through browser CORS | The loader transforms owned configuration. Production entry points do not call `esbuild.serve()`. Never start this legacy development server, including on localhost. |
| [GHSA-82fw-gwwq-j7x9](https://github.com/vitest-dev/vitest/security/advisories/GHSA-82fw-gwwq-j7x9) | Two records, for Vitest and its mocker; reachable development mock-registration WebSocket/browser RPC | Tests use `vitest run`, not UI/watch/browser RPC. No non-test application entry point imports Vitest. Better Auth references it only from the separate test-utils entry. Do not expose mock/UI/HMR test servers. |
| [GHSA-qxg6-89mg-rqv8](https://github.com/vitest-dev/vitest/security/advisories/GHSA-qxg6-89mg-rqv8) | Vitest mocker plugin registered on a reachable Vite HMR server | No direct mocker/interceptor plugin registration in the application. Node test runs do not install that handler. Do not add an exposed mock server without resolving this advisory first. |

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
