# Updating the existing feedback service

The updater fetches the latest owned `webiumsk/chorala` main revision and deploys
its prebuilt API, dashboard and worker images. It does not build on the shared VPS,
reset a working checkout, replace protected settings, change the Compose project,
recreate PostgreSQL/Redis/gateway or remove volumes. Existing read-only rootfs,
resource limits, mounts, network and proxy settings remain in the current Compose
files. Custom layouts outside the documented seven-service/three-volume contract
are refused before stopping services rather than silently rewritten.

## One-time preparation

Merge the reviewed source and wait for both **CI** and **Publish deployment images**
on main. Images use `ghcr.io/webiumsk/chorala-{api,dashboard,worker}:sha-<full-SHA>`.
The publisher runs only after successful push CI for the owned main repository;
fork/PR workflow runs cannot enter its package-write job. Set the three GHCR
packages public, or configure the VPS's existing protected Docker registry login.
Do not put a registry token into this repository, command arguments or chat.

Keep this repository's `deploy.sh`, `deploy/update.sh` and `deploy/update.py` together
on the VPS. The root script is the normal entry point. Docker
with Compose, Python 3, Git and GPG must already be installed. The updater does not
install tools. It uses the same local Unix Docker endpoint for the whole operation
and refuses remote contexts. The serving host's current capacity and trial resource
profile remain an operator responsibility; this is not an 8-GB capacity approval.

For a dedicated updater checkout, separate from the running service and its secrets:

```sh
git clone https://github.com/webiumsk/chorala.git ~/chorala-updater
cd ~/chorala-updater
```

Do not copy the protected service environment into that checkout. When the updater
itself changes, refresh this dedicated checkout with `git pull --ff-only`; local
changes must be reviewed rather than reset. Normal deployment runs fetch the latest
application revision into the isolated updater state automatically.

Use an off-host GPG encryption key and transfer only its **public recipient file**
to the VPS. Keep the private decryption key and its recovery instructions off-host.
The existing Compose environment file must be a regular, owner-only file (0600).
The updater deliberately does not guess whether it is called `.env`, `.env.trial`
or something else. It reads the existing API's Compose labels for the file list,
working directory and actual project name (`satflux-feedback-trial` on the owner's
current installation).

On the first invocation, provide the two existing paths:

```sh
bash deploy.sh --env-file /path/to/current/runtime.env --recipient-file /path/to/backup-public.asc
```

After a successful deployment the updater remembers only nonsensitive target paths
and its managed image override in owner-only `/var/lib/chorala-updater` state. Later:

```sh
bash deploy.sh
```

Use `--anchor` if the existing API container has another name, or `--state-dir` for
an explicitly selected owner-only state directory outside the serving/build context.
Never share one updater state directory between deployments. The script does not
write credentials into this state; its encrypted backup contains the protected
runtime configuration necessary for disaster recovery.

## Read-only inspection

```sh
bash deploy.sh --check --env-file /path/to/current/runtime.env --recipient-file /path/to/backup-public.asc
```

Check mode resolves the existing Compose model privately and verifies service and
volume ownership, mount targets, local driver and current application environment.
It does not fetch, pull, stop, migrate, create state or inspect the full environment
in user-facing output. Only nonsensitive project/service counts are printed.

## Update sequence

1. Lock the updater state, discover the exact existing deployment and reject an
   unfinished migration/recovery operation or incompatible local configuration.
2. Fetch the owned main into a separate bare cache and archive that exact revision.
   Existing source files, local edits and upstream repositories are untouched.
3. Pull the three full-SHA image tags. Require matching OCI revision labels and
   owned repository digests; preserve the resolved digest. If images are still
   building or registry access fails, stop before taking the service offline.
4. Prepare an image-only override and verify that the fully resolved model differs
   only in application/migration image references. Existing data-service images,
   service limits, read-only filesystems, proxy configuration and networks are not
   upgraded as a side effect.
5. Stop only previously running traffic/application writers. Flush and briefly stop
   Redis, then encrypt a paired PostgreSQL dump, upload bytes, Redis persistence,
   protected interpolation and distinct service env files, Compose/proxy files and
   image/volume metadata. Service env-file paths are collected with Compose's
   no-env-resolution mode and must also be regular owner-only files. Plaintext lives
   only in a private temporary directory outside source/build contexts and is removed.
6. Resume Redis if it was running, run the one-shot migration with the new API image,
   then start the previously running API/dashboard, verify bounded health and HTTP
   probes, start the previous worker, and resume the existing gateway.
7. Persist the active override and revision. The next update replaces its own prior
   override instead of accumulating image overrides. An exact already-running
   revision is a no-op.

Use this updater for application version changes. A manual Compose invocation that
omits the managed override can select the older image references still present in
the original operator files. The active override path is recorded in `runtime.json`
and in the running API's normal Compose labels. The updater refuses unexpected
changes to that file list rather than dropping an operator overlay.

## Changelog calendar dates (migration 0012)

This additive migration stores a nullable `display_date`, used for both displayed
dates and newest-first ordering. The administrator's **Changelog date** input
controls it; renaming or editing an entry leaves its date unchanged. Clearing it
uses the ordinary publication/creation timestamp fallback. The actual publication
timestamp and notification history remain separate.

The migration recovers the 78 reviewed Satflux merged-PR history dates by matching
the original project's deterministic import IDs. It preserves edited titles,
bodies, labels, publication status/timestamps, links, audiences and recipient counts.
These source dates record PR integration, not verified deployment dates. Unrelated
entries are not backfilled based on their titles or text.

Deploy the migrated server before the matching vendored Satflux widget. The new
widget accepts older server responses with no `displayDate`, but those responses
cannot supply recovered historical dates. Do not rerun the historical import to
repair existing entries. The older offline importer does not populate this new
field for future imports; any future import needs an explicitly reviewed date-aware
tool or dates set through the editor.

## Failure and recovery

Before migration, failures attempt to resume only services that were running before
the operation. The previous deployment and all backup evidence remain intact.
After migration starts, a failure attempts to stop application writers and verifies
their actual state. It records `recovery-required-writers-stopped` only when that is
confirmed; otherwise it records `recovery-required-stop-unconfirmed` and explicitly
requires inspection. A later automatic update is refused. Crash/interruption markers
such as `quiescing`, `backup-complete`, `migrating` or `starting-applications` are also
refused on retry. Only completed updates or verified pre-migration restoration are
automatically retryable. Never blindly restart old application images against a
possibly changed schema or promise automatic database downgrade.

Each attempt has a distinct encrypted `paired-backup.tar.gpg` and SHA256. Retain it
off-host together with the relevant source/image revision and updater state. Decrypt
only into an owner-only recovery directory; its `SHA256SUMS.json` covers the database,
upload/Redis archives, protected configuration copies and metadata. The recorded
configuration-path map identifies each original operator file. This updater format
preserves arbitrary supported trial overlays; the older strict `deploy/restore.sh`
does **not** directly accept it. Do not describe that wrapper as its restore command.

Recovery requires a deliberately selected isolated/new project: matching PostgreSQL
major and application images, restoration of the database dump, upload and Redis
archives, and exactly matching auth/configuration secrets. Verify checksums and
relationships before enabling writers; disable external delivery while validating
pending Redis jobs. Promote a recovered deployment only after its own acceptance.
Do not overwrite the live project's database/volumes merely because an update failed.

Package publication and registry permissions follow
[GitHub's container publishing guidance](https://docs.github.com/en/actions/tutorials/publish-packages/publish-docker-images).
The privileged publisher's source guards follow the documented
[workflow_run security boundary](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run).
