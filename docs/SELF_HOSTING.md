# Operating the owned Chorala fork

For the Satflux deployment on an existing shared host with Traefik, use the
[image-only deployment runbook](DEPLOYMENT_SATFLUX.md) and standalone
`deploy/compose.traefik.yml`. The original Compose commands below describe the
bundled Caddy edge and must not take ports 80/443 from an existing proxy.

This owned fork is intended for Satflux, preserving the upstream feature set.
Upstream multi-project capabilities remain available without a new SaaS offering.
Use a separate project public key, end-user signing secret and allowed-origin list
for each application. Projects in the same organization share organization staff;
use separate organizations when staff access must be isolated.

## Configuration and first start

Copy `.env.example` to an untracked `.env`. Generate independent random values for
`CHORALA_AUTH_SECRET` and `CHORALA_DB_PASSWORD`; for example, use separate
`openssl rand -hex 32` invocations. The database password must contain only
letters, numbers, `_` or `-` and at least 32 characters, because Compose constructs
its internal database connection URL. Never commit the resulting file or pass
real deployment secrets as Docker build arguments.

Set the public URLs to the externally reachable HTTPS origin:

```dotenv
CHORALA_DOMAIN=feedback.example.com
CHORALA_PUBLIC_URL=https://feedback.example.com
CHORALA_API_URL=https://feedback.example.com
CHORALA_WIDGET_CDN_URL=https://feedback.example.com/widget.js
CHORALA_DEPLOYMENT=selfhost
```

`CHORALA_ADMIN_HOSTS` optionally adds comma-separated administrative aliases. Those
aliases redirect to the canonical `CHORALA_PUBLIC_URL`, keeping authentication
and write origins on the configured canonical host. The public URL host and local
loopback hosts are already recognized. Other hosts resolve a project portal; they
do not acquire admin routing through `X-Forwarded-Host`. Each custom domain must
also be assigned to its project and explicitly included in the Caddy site
addresses through `CHORALA_DOMAIN`, with DNS directed at this installation. This
configuration does not enable unrestricted on-demand certificates.

For local `pnpm dev`, use dashboard URL `http://localhost:3015`, API URL
`http://localhost:8787`, and widget URL `http://localhost:8787/widget.js` instead.
`CHORALA_API_PORT` controls the internal listener independently of the public URL;
the Compose stack fixes that internal port at 8787 for its proxy and health check.

Before an approved first deployment, run:

```sh
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
```

The one-shot `migrate` service must complete successfully before API startup. The
worker and dashboard wait for API health, and the edge waits for both API and
dashboard health. Application health is an HTTP readiness signal, not proof that
email, AI providers or every integration is configured. Configure optional services
and verify their actual behavior in staging. Use `CHORALA_AI_PROVIDER=none` and
`CHORALA_EMAIL_TRANSPORT=none` when those services are intentionally disabled.

Create the first administrator through the explicit-credential bootstrap command:
set `CHORALA_BOOTSTRAP_EMAIL`, a unique `CHORALA_BOOTSTRAP_PASSWORD` of 16-128
characters, and optionally `CHORALA_BOOTSTRAP_NAME` in the protected environment,
then run `docker compose exec api pnpm --filter @chorala/api seed:admin`. Remove
the bootstrap password from the deployment environment after successful setup.
Self-host public signup is disabled by default (`CHORALA_ALLOW_SIGNUP=false`);
invitation acceptance currently requires an existing account. Until dedicated
invite-only registration is implemented, create additional accounts during a
controlled onboarding window: restrict network access, explicitly enable signup,
create the intended accounts, disable signup again, then accept their invitations.
Do not describe this temporary opening as invite-only registration. Do not run demo database seeds
or use the upstream demonstration account/password in production. Existing accounts
must not be deleted or reset as a side effect of first-admin setup.

The API image builds and verifies `packages/widget/dist/widget.js`; no missing
widget stub should be accepted as a working deployment. Runtime images use the
Node 24 version specified by the repository, matching CI.

## Persistent attachments

The `chorala_uploads` named volume is mounted at the same absolute path in the API,
dashboard and worker. The API writes it; dashboard and worker mounts are read-only.
Container recreation therefore does not remove screenshots or make them invisible
to the dashboard. Do not replace it with a container-local `/tmp` directory.

Back up attachments together with their database rows. Database-only backups and
CSV exports are insufficient: CSV omits full bodies, comments, identities and
attachment bytes. Preserve project privacy and attachment permissions during any
copy or migration.

## Backup and recovery

A recoverable backup set includes:

- A PostgreSQL dump from the exact application schema/revision.
- The complete `chorala_uploads` volume from the same consistent point in time.
- The protected deployment configuration, especially `CHORALA_AUTH_SECRET`,
  project signing secrets and integration credentials. Encryption depends on these
  values, so replacing the auth secret can make stored integration secrets unreadable.
- The deployed commit/image identifiers and migration history.
- Redis persistence when pending email, webhook and AI jobs must be recovered.

Stop writes and workers while taking a consistent database/filesystem snapshot,
or use infrastructure snapshot facilities that provide an equivalent consistency
guarantee. Store backups encrypted outside the serving host and restrict access;
never put them in this repository, a public container image or CI artifacts.

Test recovery into a separately named Compose project with separate volumes and
ports. Restore the matching database, upload files and required secrets before
starting application processes. Start migration/API dependencies in order and
verify authorized screenshot reads, project boundaries, comments, votes and
notifications using synthetic fixtures. Pending external notifications must not be
replayed to real recipients during restore tests.

Rollback requires a schema-compatible image or restoration of the complete matching
backup set. Starting an older application against a newer schema is not assumed
safe. Record migration reversibility and expected downtime before each release.

No production deployment, backup or restore is executed merely by adding this guide.

## Disposable production-image verification

`compose.smoke.yml` overlays the real Dockerfiles and startup sequence with a
dedicated `chorala-fork-smoke` project, synthetic credentials, disabled AI/email
providers, no operator environment file, and only `127.0.0.1:18094` published.
Check that this loopback port is free before starting it. Never reuse its
credentials or settings for a deployed installation.

```sh
export CHORALA_DB_PASSWORD=synthetic_smoke_database_password_1234567890
docker compose --env-file /dev/null -p chorala-fork-smoke \
  -f docker-compose.yml -f compose.smoke.yml config --quiet
docker compose --env-file /dev/null -p chorala-fork-smoke \
  -f docker-compose.yml -f compose.smoke.yml build api dashboard worker migrate
docker compose --env-file /dev/null -p chorala-fork-smoke \
  -f docker-compose.yml -f compose.smoke.yml up -d --wait
```

At the reviewed fork working-tree scope, actual production-image checks verified:

- Migrations complete before API startup; the API health endpoint and edge-served
  real widget and login page respond successfully.
- The first-admin bootstrap creates one administrator and refuses a repeated
  invocation without replacing the account.
- Authenticated project creation, a validated screenshot, linked feedback, voting
  and comments work through the edge. The dashboard reads the API-written image
  from the shared volume; anonymous requests cannot read its bytes.
- Recreating API and dashboard containers preserves those records and the exact
  authorized screenshot bytes. The dashboard upload mount rejects writes.
- With writers stopped, PostgreSQL and upload backups were created, the disposable
  volumes were deleted, and both backups were restored into fresh volumes using
  the same synthetic auth configuration. User, project, post, comment, vote and
  attachment counts matched; restored sessions and screenshot reads still worked.
- The same dashboard image follows runtime registration policy changes: closed,
  temporarily displaying the form, then closed again. The public API remained
  closed throughout that UI-only check.
- Actual API and dashboard images contain no operator `.env` file.
- A runtime-configured administrative alias returns HTTP 307 to the canonical
  origin while preserving path and query. An unknown customer host with a spoofed
  forwarded alias remains a portal lookup and cannot select the admin application.

Separate coordinator checks passed a real browser journey from login through idea
submission, voting, an admin status change and public roadmap display. A Node 24
MCP stdio client completed the nine-tool handshake and exercised read-key requests
for boards, top requests, a post with comments and feedback search against the
restored API. These checks used private synthetic credentials, never published
tokens or production records.

These checks used synthetic local data. Real TLS/DNS, external email/AI providers
and pending-job recovery were not exercised by this smoke run. A database/upload
restore does not establish Redis queue recovery. Follow the approval and staging
checks before connecting Satflux to a deployed instance.

Clean up only this disposable project when its QA is finished:

```sh
docker compose --env-file /dev/null -p chorala-fork-smoke \
  -f docker-compose.yml -f compose.smoke.yml down --volumes --remove-orphans
```
