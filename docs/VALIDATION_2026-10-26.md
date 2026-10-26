# Changelog management and updater validation

Base: owned `webiumsk/chorala` main
`87d0f443b00e8a55d80337856ef9f41b37278ef4`.

## Accepted implementation scope

Existing imported drafts can be selected, edited, saved, explicitly published and
deleted with confirmation. The client snapshots native form data and its submitter
before pending disables controls, preserving explicit publication intent and the
controlled audience. The server independently checks session, write role and project
scope. Ordinary dashboard edits retain linked posts, status and publication date.
The editor preview and public changelog share a React-only Markdown renderer;
untrusted HTML remains text and images are never loaded.

The core update service locks the scoped entry while deciding whether publication
actually transitioned. Concurrent publication requests schedule one transition's
delivery. Database commit and Redis enqueue remain separate; no outbox or atomic
cross-service delivery guarantee is introduced. The unchanged HTTP API partial
schema is not covered by the dashboard form's omitted-field preservation fix.

The updater preserves the existing image-only Compose project and protected
configuration. It fetches owned main, checks matching CI-built image revisions and
digests, quiesces scoped writers, encrypts paired recovery evidence, migrates and
resumes only previously running applications after readiness checks. An interrupted
operation blocks automatic retries. It never builds on the serving host, resets a
working checkout, recreates data services or promises automatic schema downgrade.
Its backup format is described in UPDATING.md and is not accepted by the older
strict restore wrapper without an explicit recovery procedure.

The image publisher is restricted to successful push CI for the owned main branch
and its exact commit. Package-write permission exists only in that guarded job.
No image publication, production upgrade or real provider delivery was performed
as part of local preparation.

## Local evidence

- Author and independent runs passed the 8 strict form-parser cases and 4 Markdown
  rendering/security cases. CI now runs these through the existing API tsx tool.
- Author and independent real PostgreSQL runs passed 4 management cases, including
  eight parallel publish requests, repeated published saves, preservation of
  relationships/dates and role/organization/project denials.
- The deployment guard suite passes 58 cases: 36 existing and 22 updater cases.
  Python compilation and shell syntax checks pass.
- Dashboard production build and typechecking pass on Node 24.22.1. The inherited
  BullMQ dynamic-dependency build warning remains; no new dependency was added.
- Independent regression verified 194 application cases plus the 12 dashboard
  cases, all 20 workspace typecheck tasks and the production dashboard build.
  Full Biome passes with the same six warnings in untouched files.
- Eleven independent actual Chrome journey checks passed: existing imported entry
  hydration, ID/relationship/audience preservation, failed-save retention, dirty
  cancellation, keyboard draft submission, 390-pixel layout, explicit publication,
  unchanged publication date/no repeated delivery on edits, confirmed deletion,
  denied write roles, anonymous actions and foreign-Origin rejection. A persistent
  Playwright changelog regression also passed and cleans up its own fixture.
- Independent actual updater recovery passed model/runtime/volume validation,
  encrypted paired backup, decryption and all checksums. A fresh PostgreSQL 16
  restore recovered 32 public tables and exact changelog relationships/content;
  fresh upload and Redis volumes retained binary bytes and pending-job state.
  Distinct interpolation/service environment files and proxy bytes were preserved.
  Injected encryption failure removed partial output and plaintext. Updater
  lifecycle command ordering and failure refusal were additionally checked with
  fake commands; no GitHub/registry/production lifecycle was executed locally.

Independent security review accepted the final scoped source after six updater
findings were corrected: durable incomplete-phase handling, physical state-directory
boundaries, exact mount/runtime drift checks, truthful stop confirmation, cleanup
despite journal errors and inclusion of distinct service environment files.

All stateful tests use explicitly provisioned synthetic PostgreSQL/Redis, disabled
external providers and loopback/internal test routing. No production wallets,
merchant accounts, provider credentials or real subscriber deliveries are used.
Graphify is absent in the isolated target; source inspection used bounded reads.
All owned QA containers, volumes, networks and ephemeral recovery keys are removed
after verification. The root `deploy.sh` is a syntax-checked convenience entry point
for the same reviewed updater; `--help` does not contact Docker or the registry.

## Operator handoff

See [changelog management](CHANGELOG_MANAGEMENT.md) and
[updating the existing service](UPDATING.md). The first updater invocation needs the
actual protected Compose env-file path and a public GPG backup-recipient file.
Later invocations reuse only the nonsensitive stored paths. Existing GitHub issue
integration, widget keys and project signing secrets are not changed by this work.
