# Owned Satflux fork validation — 2026-10-25

## Scope and revisions

Own repository: `webiumsk/chorala`, PR #1, branch `fix/satflux-self-hosting`.
Upstream base: `6cb0cc7bc2c13679f188834c47c08a3ed2024946` (read-only).
Initial source/hosting fixes: `b4d825ea058cc243fe981282ff2226fcf32708a8`.
Dependency/MCP/email/media follow-up: `fecff764ff9aa001986e49b3e5a6eecb8f075aa7`.

Final lockfile SHA256:
`d9004b86383dcea939c2b5e0c9b5a5ccb0c665749d12da0719b966da2a9306bf`.

Final intended use is one separately operated instance for Satflux. No production
configuration, historical hosted data, real funds or external provider was used.
All runtime checks target explicit disposable resources with synthetic credentials.

## Independent security review

Reviewer `/root/feedback_architecture_security` accepted the bounded source and
dependency remediation after independently checking manifests, lockfile, actual
runtime entry points, MCP HTTP controls, email privacy, raster prefilter and tests.
The reviewer did not author these fixes or modify the repository.

Full and production audits each report zero critical/high/low and four moderate
records, with no suppressions. See `DEPENDENCY_SECURITY.md` for the three distinct
remaining advisories, absent runtime preconditions and operating restrictions.
The old legacy esbuild HTTP server must stay disabled even on localhost.

Authentication precedes MCP parsing/SDK creation; explicit body and collection
budgets apply. SMTP tests exercise actual authentication and rejection; no-op
logs contain no message data. Raster signatures precede patched native decoding,
without relaxing dimensions, animation, authorization or quota controls.

No blocking code finding remains in this follow-up scope. Acceptance does not
cover enabling untrusted webhook destinations, exposing development servers or
production deployment. Material changes/failures require renewed review.

## Independent QA

Reviewer `/root/chorala_dependency_qa` independently ran tests in Node 24.22.1
with no external network and read-only source/root:

- Six real-SDK MCP HTTP tests: missing/wrong token before parsing or SDK creation,
  nine-tool initialization, repeated calls, bounded arguments, declared/chunked
  body rejection and browser-origin denial.
- Four real loopback SMTP tests: MIME/envelope preservation, AUTH, recipient 550
  propagation without DATA delivery, disabled-mode privacy and no connection.
- All 32 widget cases with Vitest 3.2.7's thread pool and Tinypool 2.1.2. The full
  suite separately uses the default fork pool.
- Read-only comparison of all 16 workspace importers and overrides with manifests.
- Actual tsup 8.5.1 widget build; resolved esbuild JS and executable both 0.28.1.
- Actual Chrome against the built bundle: all 15 requests intercepted, zero
  unexpected requests or browser errors. JWT renewal preserves drafts/screenshots;
  account/logout/project changes clear floating and inline state. All six locales
  and both complete MIT notices pass.

Built widget SHA256:
`9ec5e5a5b569df3b1cc30cdc2e099b3c7d7dd60dfddc4899b67e261ccd337828`.
Size: 46,503 bytes; gzip: 16,842 bytes (below 40 KiB).

Fresh bootstrap concurrency used a uniquely prefixed database in the verified
tmpfs test PostgreSQL. Two real advisory-lock waiters were observed: one process
created the administrator, one refused; exactly one user/account/member/org/owner
remained, with no credentials logged. The database was dropped. An earlier short
timing window observed no contention and was not counted as a pass; extending only
the temporary harness barrier/deadline produced the actual contention proof.

## Coordinator checks

The final-lock full suite passed 190 cases: 169 Vitest (API 66, core 54, widget 32,
AI 14, database 3), eleven Node configuration, six MCP HTTP and four SMTP tests.
The no-key stdio smoke explicitly skips in that suite; live API evidence is separate.
Biome passes with six unchanged warnings in untouched theme/AI source.

All twenty final-lock typecheck tasks passed locally. GitHub
[CI for `fecff764`](https://github.com/webiumsk/chorala/actions/runs/40144502065)
passed frozen installation, the complete audit gate, lint, typecheck, all fifteen
build tasks, migration/seed and the full test suite under Node 24. Documentation-only
follow-ups retain the same runtime source and lockfile. Exact-head checks remain
visible on [PR #1](https://github.com/webiumsk/chorala/pull/1).

Rebuilt-image startup and live browser/MCP evidence are recorded separately on that
PR after checking image lockfile hashes. Earlier image results below are historical
and do not substitute for verification of the updated images.

## Historical recovery proof

Initial images built from the first source-fix graph passed migrations, startup,
recreation and a full PostgreSQL/uploads restore after deleting the disposable
volumes. Relationships, account/session continuity, media authorization and exact
screenshot bytes survived. The restored stack passed a browser feedback/vote/staff
status/roadmap journey and live MCP reads/search exposing nine tools.

This proof predates the dependency follow-up; later existing-data checks establish
the updated image pairing. No historical chorala.com data was recovered. Full
migration needs its database, attachments and service secrets or complete export.

## Limits

Real TLS/DNS, external SMTP/AI/integration delivery and Redis job recovery remain
staging/release checks. Generic webhook egress requires a separate SSRF/redirect
review before untrusted destinations are enabled. Images retain upstream's root
user baseline. No merge or production deployment has been performed or authorized.
