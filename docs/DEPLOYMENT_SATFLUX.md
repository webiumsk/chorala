# Deploying Satflux feedback behind the existing Traefik

This is a preparation and operator runbook, not an executed deployment. Target:
`https://feedback.satflux.io` on the owner's Hetzner services host. The existing
Passbolt, Evolu and other services keep their own configuration and data.

## Prepared artifacts and remaining inputs

`deploy/compose.traefik.yml` is a standalone, image-only Compose project. Do not
combine it with the development `docker-compose.yml`. It uses immutable local
image IDs and never builds or pulls on the serving host. `deploy/images.lock.json`
records the reviewed images, platform and runtime-source revision.

The offline bundle contains the full corresponding source, Docker image archive,
manifest and file checksums. The runtime source remains `9b010f0`; deployment-only
preparation has its own revision. Embedded source/hash verification is not a claim
that rebuilding with arbitrary toolchains reproduces identical compiled images.
The included AGPL source and license notices must remain available to users.

Before execution, confirm:

- Applicable owner approval for the source merge and actual deployment. Preparation
  does not authorize VPS resizing, DNS changes or restarting existing services.
- An amd64 Linux Docker host, Python 3.10+, Bash, Docker Compose v2, GPG and ordinary
  system utilities. The reviewed runtime images use Node 24 internally.
- Host capacity: the production profile targets at least 8 GB total RAM. This is a
  conservative shared-host operating policy, not a measured Chorala minimum. The
  current CX23 has 4 GB and about 1.5 GiB available in one supplied snapshot. An
  explicit small-host override is for a controlled trial, not production acceptance.
- A dedicated Docker ingress network for Traefik and the Chorala gateway. Do not
  connect the gateway to Passbolt's private database network merely because Traefik
  is present there. Backend networks and volumes remain separate.
- The actual Traefik HTTPS entrypoint and certificate resolver. Their names are
  mandatory inputs. The owner's probe reports entrypoints `web`/`websecure` and
  resolver `letsencrypt`; this profile explicitly selects `websecure` and
  `letsencrypt`. Real TLS behavior still needs target acceptance.
- Free storage for the transferred archive, loaded Docker layers, database/uploads
  growth and a protected backup staging directory. Check the actual Docker storage
  filesystem before import; a successful RAM check does not establish disk capacity.
- A protected backup recipient public key and an off-host recovery private key.
  Keep real settings and keys out of Git, images, logs and support transcripts.

## Build-host preparation

On the trusted build host with the six reviewed images already loaded:

```sh
python3 deploy/prepare-bundle.py --verify-images-only
python3 deploy/prepare-bundle.py --output /protected-output/chorala-bundle
```

The output must be new and outside the checkout/build context. The builder checks
273 committed runtime inputs inside each application image, the exact lockfile,
Node version, platform and absence of operator environment files. It saves the
selected immutable IDs with shared layers and includes only committed source.
No registry publication, remote-host operation or image rebuild is performed.

Transfer the completed directory through an authenticated operator channel. Check
the manifest's expected revisions and compare its checksum through the trusted
handoff. Checksums detect changes; they are not an independent signing system.

## Read-only target discovery

The probe queries selected Docker metadata only. It does not output environment
values, complete inspect results, private keys or arbitrary proxy arguments.
It refuses remote Docker contexts, because memory must describe the same host.

```sh
python3 source/deploy/inspect-target.py \
  --traefik-container passbolt-traefik-1 \
  --router-container passbolt-passbolt-1
```

The report lists observed network names, HTTPS entrypoints, certificate resolver
names and exact proxy address CIDRs. Multiple candidates require explicit selection.
The supplied report shows only `passbolt_default` with seven attached containers;
that is not an approved dedicated feedback ingress. Its reported proxy address
must not be reused as the trusted address on the new network.
File-based Traefik settings may need a local operator check of these names only;
never post complete production Compose, `.env`, ACME state or credentials.

## Approved infrastructure preparation

After the applicable host-change approval, make `feedback.satflux.io` resolve to
the selected host and check whether an existing AAAA record points somewhere else.
Use the existing Traefik TLS setup. Do not start another listener on ports 80/443.

If no dedicated ingress network exists, the planned name is
`satflux-feedback-proxy`. Creation and attaching the existing Traefik are host
changes to perform only as part of the approved deployment:

```sh
docker network create --driver bridge satflux-feedback-proxy
docker network connect satflux-feedback-proxy passbolt-traefik-1
```

First verify that this name is not already used for another purpose. Preserve every
existing Traefik network. A manual network attachment is not durable across container
recreation: add the external network to the existing Traefik stack's own Compose
configuration using its actual service name and existing network declarations.
Do not blindly replace that stack or apply a fragment that drops its other networks.
Review that target-specific change before execution. No Passbolt database or volume
is shared with Chorala.

`deploy/traefik-network.example.yml` provides the small network-only fragment for
review against the actual existing stack. Verify its service name and preserve all
current networks. Include it in that stack's normal persistent Compose invocation;
validate the merged configuration with `config --quiet`. Do not apply a standalone
fragment or recreate the shared proxy without the agreed maintenance approval.

Re-run the read-only probe after the network attachment and save its output locally
with owner-only permissions. The exact Traefik address on the selected network is
trusted as `/32` or `/128`, not a broad private subnet. If Traefik is recreated with
a different address, re-probe and update/reload the Chorala gateway configuration.
Do not broaden trust to hide a changed address. Traefik must not trust arbitrary
internet-supplied forwarded headers; Cloudflare/tunnel chains need an explicit
target-specific trust test.

## Verify and initialize on the serving host

From the transferred bundle directory:

```sh
sha256sum -c SHA256SUMS
docker image load --input images.tar.gz
umask 077
python3 source/deploy/inspect-target.py \
  --traefik-container passbolt-traefik-1 \
  --router-container passbolt-passbolt-1 > target-report.json
```

Then initialize the protected file with the selected names from the owner's probe
and the newly observed dedicated-network address. The network argument is always
explicit, even when only one was observed:

```sh
python3 source/deploy/init-config.py --target-report target-report.json \
  --network satflux-feedback-proxy \
  --entrypoint websecure --resolver letsencrypt
```

The initializer creates `source/deploy/.env` with mode 0600 and refuses to overwrite
an existing file or symlink. It generates independent database/auth secrets and
fills the exact image IDs. It never prints secrets and never starts a service.
Bootstrap administrator credentials remain blank; do not store them in the shared
runtime file that is passed to every application container.

Review the file locally. Keep self-host mode, canonical HTTPS URLs and public signup
closed. AI and email are deliberately disabled until a real provider is configured
and verified; local model hosting is outside this capacity profile. Retain the auth
secret with the database because integration encryption depends on it.

Run the preflight with the protected environment file:

```sh
python3 source/deploy/preflight.py --env-file source/deploy/.env \
  --project satflux-feedback --router-container passbolt-passbolt-1
```

It must pass the real target's memory, local-daemon, architecture, immutable-image,
ingress, proxy-address, canonical-origin and permission checks before startup.
Do not use `docker compose config` without `--quiet` in a support log, because
resolved configuration contains credentials.

## Approved startup and initial administrator

Use the dedicated project name consistently. Startup is a production action:

```sh
cd source/deploy
docker compose --env-file .env -f compose.traefik.yml \
  -p satflux-feedback up -d --no-build --pull never --wait
docker compose --env-file .env -f compose.traefik.yml \
  -p satflux-feedback ps
```

PostgreSQL health precedes the one-shot migration; the API waits for that migration,
the dashboard/worker wait for API health and the gateway waits for application
readiness. A successful `ps` does not establish SMTP, AI, CORS or end-to-end behavior.
Never run the demo `db:seed` in this installation.

Supply first-admin credentials only to a temporary API container. The password is
read without terminal echo and is not a literal shell argument:

```sh
read -r -p 'Administrator email: ' CHORALA_BOOTSTRAP_EMAIL
read -r -s -p 'New administrator password (16-128 characters): ' CHORALA_BOOTSTRAP_PASSWORD
export CHORALA_BOOTSTRAP_EMAIL CHORALA_BOOTSTRAP_PASSWORD
docker compose --env-file .env -f compose.traefik.yml -p satflux-feedback \
  run --rm --no-deps --pull never \
  -e CHORALA_BOOTSTRAP_EMAIL -e CHORALA_BOOTSTRAP_PASSWORD \
  api pnpm --filter @chorala/api seed:admin
unset CHORALA_BOOTSTRAP_EMAIL CHORALA_BOOTSTRAP_PASSWORD
```

Use a unique password. The bootstrap refuses an occupied installation; it must not
reset an existing account. Keep signup closed. Additional staff onboarding must use
the explicitly documented controlled workflow, not an assumed invite-only signup.

## Satflux project and activation

Create the Satflux organization/project, board(s), required statuses and project
appearance. Allow the exact deployed Satflux origin only. Keep public/hidden board
and screenshot visibility intentional. Copy the following through the normal
protected Satflux configuration mechanism:

| Satflux setting | Source |
| --- | --- |
| `CHORALA_WIDGET_URL` | `https://feedback.satflux.io`, without an API or script suffix |
| `CHORALA_PROJECT_KEY` | Public widget key of the new Satflux project |
| `CHORALA_PROJECT_ID` | New project ID |
| `CHORALA_API_KEY` | Project-scoped read key for optional appearance synchronization |
| `CHORALA_END_USER_JWT_SECRET` | Protected signing secret of this same project |

The existing authenticated one-hour JWT/direct-API integration remains in use.
Deploy the reviewed Satflux widget correction from PR #401 as well: deploying the
server alone does not replace Satflux's locally pinned widget. Clear only the normal
application configuration cache through the approved Satflux deployment process;
do not copy operator secrets into build assets or disable CSRF.

Before activation, use staging/synthetic accounts to verify HTTPS redirects and
discovery URLs, a valid certificate, origin rejection, closed signup, feedback with
an explicitly selected screenshot, permissions on screenshot reads, vote/comment,
staff status change and roadmap. Test same-user renewal with retained drafts and
account/logout/project reset, plus EN/SK/ES/DE/CS. Test actual notification delivery
and queue retries before enabling email; API health with `none` is not delivery.

## Backup, recovery and rollback

Use a public backup recipient key whose private key is stored off-host. From the
deployed `source/deploy` directory, an approved backup invocation is:

```sh
./backup.sh --env-file .env --project satflux-feedback \
  --recipient-file /protected-keys/feedback-recipient.pub \
  --output /protected-backups/feedback-YYYYMMDD.tar.gpg
```

These are operator-selected paths; use a new output file and protected directories.
The backup creates an encrypted, paired database/upload/runtime-configuration/Redis
set with a manifest and checksums. Quiescing writers causes an intentional Chorala
maintenance window; existing unrelated services are outside its project scope.
Only services that were running beforehand may be restarted by cleanup paths.

Store encrypted backups off-host and test recovery. A restore consumes an
offline-decrypted owner-only archive into a new, empty, explicitly named restore
project. It refuses populated targets and unsafe archive paths/links. It leaves
notification-producing services stopped with providers disabled for inspection.
On the isolated recovery host with matching images loaded, decrypt using the
off-host private key and run the matching trusted bundle's restore script:

```sh
umask 077
gpg --output /protected-recovery/feedback.tar \
  --decrypt /protected-backups/feedback-YYYYMMDD.tar.gpg
./restore.sh --archive /protected-recovery/feedback.tar \
  --target-dir /protected-recovery/instance \
  --project satflux-feedback-restore-verify --confirm-empty-target
```

The decrypted file and parent directory must remain protected. Keep them only for
the controlled recovery window. The confirmation flag does not permit overwriting
existing project data; scripts independently check the empty-target condition.
Never attach a test restore to real recipients, the production Traefik or live
Satflux. Redis recovery does not promise exactly-once delivery of external effects;
inspect pending jobs before enabling a restored worker.

For a rollback without data loss, choose only an image explicitly compatible with
the current schema. Otherwise restore the entire matching backup and its auth
secret, accepting the agreed recovery point. Do not run an arbitrary old image
against newer schema, remove live volumes or use global Docker pruning.

Old hosted Chorala history is separate: it requires complete database, attachment
and secret/export access. CSV alone is not a complete backup; no hosted history
has been recovered by these preparation steps.

## Verification record

The final preparation revision, local image IDs, archive checksums, independent
security/QA results and remaining operator inputs are recorded after the isolated
Traefik startup and encrypted backup/restore checks. Real host capacity, DNS/TLS,
the deployed Traefik version/forwarded-header chain and external provider delivery
remain target acceptance checks, not conclusions from a local fixture.
