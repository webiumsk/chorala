#!/usr/bin/env python3
"""Validate the prepared profile, or perform explicitly scoped paired backup/restore."""

import argparse
from datetime import datetime, timezone
import hashlib
import ipaddress
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile

HERE = Path(__file__).resolve().parent
HOST = "feedback.satflux.io"
GIB = 1024 ** 3
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}\Z")
PIN = re.compile(r"(?:sha256:[0-9a-f]{64}|[a-zA-Z0-9][a-zA-Z0-9._:/-]*@sha256:[0-9a-f]{64})\Z")
PROJECT = re.compile(r"satflux-feedback(?:-(?:qa|staging)-[a-z0-9][a-z0-9-]{0,40})?\Z")
RESTORE_PROJECT = re.compile(r"satflux-feedback-restore-[a-z0-9][a-z0-9-]{0,40}\Z")
IMAGE_KEYS = {name: f"CHORALA_{name.upper()}_IMAGE" for name in ("api", "dashboard", "worker", "postgres", "redis", "gateway")}
SERVICES = set(IMAGE_KEYS) | {"migrate"}
WRITERS = ("gateway", "worker", "dashboard", "api", "migrate")
BACKUP_FILES = {"protected.env", "compose.traefik.yml", "Caddyfile", "database.dump", "uploads.tar", "redis.tar", "metadata.json"}
_DOCKER_ENDPOINT = None


def run(args, *, env=None, timeout=30, stdin=None, stdout=None, _bootstrap=False):
    """Run a fixed argument array without exposing subprocess output on errors."""
    child_env = dict(os.environ if env is None else env)
    if args[0] == "docker" and not _bootstrap:
        endpoint = require_local_daemon()
        args = ["docker", "--host", endpoint] + list(args[1:])
        child_env.pop("DOCKER_HOST", None)
        child_env.pop("DOCKER_CONTEXT", None)
    elif _DOCKER_ENDPOINT is not None and not _bootstrap:
        # The read-only Python inspector must inspect the same daemon too.
        child_env.pop("DOCKER_CONTEXT", None)
        child_env["DOCKER_HOST"] = _DOCKER_ENDPOINT
    try:
        result = subprocess.run(args, env=child_env, stdin=stdin, stdout=stdout or subprocess.PIPE,
                                stderr=subprocess.PIPE, check=True, timeout=timeout)
        return result.stdout.decode() if result.stdout is not None else ""
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("An operation failed; sensitive subprocess output was withheld.") from exc


def require_private_file(path):
    """Require a regular owner-only file instead of following a secret-file link."""
    mode = path.lstat().st_mode
    if not stat.S_ISREG(mode) or stat.S_IMODE(mode) & 0o077:
        raise ValueError("Protected configuration/archive must be a regular file with mode 0600 or stricter.")


def load_env(path):
    """Parse literal one-line dotenv entries without shell evaluation or expansion."""
    require_private_file(path)
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, sep, value = line.partition("=")
        if not sep or not re.fullmatch(r"[A-Z][A-Z0-9_]*", key) or key in values:
            raise ValueError("Protected environment contains a malformed or duplicate key.")
        if not (key.startswith(("CHORALA_", "TRAEFIK_")) or key in {"SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "RESEND_API_KEY", "GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"}):
            raise ValueError("Only application/proxy configuration keys belong in the protected runtime file.")
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            quote = value[0]
            value = value[1:-1]
            if quote in value:
                raise ValueError("Use one literal quoting style without embedded matching quotes.")
        elif any(char.isspace() or char in "#\"'" for char in value):
            raise ValueError("Quote environment values containing spaces, quotes or comment characters.")
        if any(ord(c) < 32 for c in value) or "$" in value or "`" in value or "\\" in value:
            raise ValueError("Use literal single-line environment values without expansion or escape sequences.")
        values[key] = value
    return values


def validate_settings(values):
    """Fail closed on unknown proxy identity, secret gaps and mutable image references."""
    expected = {"CHORALA_DEPLOYMENT": "selfhost", "CHORALA_DOMAIN": HOST,
                "CHORALA_PUBLIC_URL": f"https://{HOST}", "CHORALA_API_URL": f"https://{HOST}",
                "CHORALA_WIDGET_CDN_URL": f"https://{HOST}/widget.js", "CHORALA_ALLOW_SIGNUP": "false"}
    if any(values.get(key) != value for key, value in expected.items()) or values.get("CHORALA_ADMIN_HOSTS", ""):
        raise ValueError("Canonical HTTPS origins, selfhost mode, closed signup and empty admin aliases are required.")
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,}", values.get("CHORALA_DB_PASSWORD", "")):
        raise ValueError("Set an independent URL-safe database password of at least 32 characters.")
    if len(values.get("CHORALA_AUTH_SECRET", "")) < 32:
        raise ValueError("Set an independent auth secret of at least 32 characters.")
    if values["CHORALA_AUTH_SECRET"] == values["CHORALA_DB_PASSWORD"]:
        raise ValueError("Database and auth secrets must be independent.")
    if any(values.get(key) for key in ("CHORALA_BOOTSTRAP_EMAIL", "CHORALA_BOOTSTRAP_PASSWORD", "CHORALA_BOOTSTRAP_NAME")):
        raise ValueError("Keep bootstrap fields empty; supply credentials only to the explicit one-off seed command.")
    for key in IMAGE_KEYS.values():
        if not PIN.fullmatch(values.get(key, "")):
            raise ValueError(f"{key} must be a loaded immutable image ID or repository digest.")
    for key in ("TRAEFIK_HTTPS_ENTRYPOINT", "TRAEFIK_CERT_RESOLVER"):
        if not TOKEN.fullmatch(values.get(key, "")):
            raise ValueError(f"Set the existing {key}; proxy names are never inferred.")
    for key in ("TRAEFIK_CONTAINER", "TRAEFIK_NETWORK"):
        if not NAME.fullmatch(values.get(key, "")):
            raise ValueError(f"Set the existing {key}.")
    cidrs = values.get("CHORALA_TRUSTED_PROXY_CIDRS", "").split()
    if not cidrs:
        raise ValueError("Set exact current Traefik proxy IP CIDRs.")
    try:
        parsed = [ipaddress.ip_network(value, strict=True) for value in cidrs]
    except ValueError as exc:
        raise ValueError("Trusted proxy values must be exact IPv4 /32 or IPv6 /128 CIDRs.") from exc
    if any(network.prefixlen != network.max_prefixlen for network in parsed) or len(set(cidrs)) != len(cidrs):
        raise ValueError("Broad or duplicate trusted-proxy ranges are not allowed.")
    if values.get("CHORALA_AI_PROVIDER", "none") not in {"none", "openai", "anthropic"}:
        raise ValueError("This shared-host profile does not run local AI models.")
    if values.get("CHORALA_EMAIL_TRANSPORT", "none") not in {"none", "smtp", "resend"}:
        raise ValueError("Select an explicit supported email transport.")
    return values


def command_env(values):
    """Make Compose interpolation use the same reviewed file despite ambient exports."""
    env = os.environ.copy()
    env.update(values)
    return env


def require_local_daemon():
    """Honor Docker context precedence before every mutating project operation."""
    global _DOCKER_ENDPOINT
    if _DOCKER_ENDPOINT is not None:
        return _DOCKER_ENDPOINT
    if os.environ.get("DOCKER_CONTEXT"):
        endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}", os.environ["DOCKER_CONTEXT"]], _bootstrap=True).strip()
    elif os.environ.get("DOCKER_HOST"):
        endpoint = os.environ["DOCKER_HOST"]
    else:
        endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], _bootstrap=True).strip()
    if not endpoint.startswith("unix://"):
        raise ValueError("Use a verified local Unix-socket Docker context; remote contexts are refused.")
    _DOCKER_ENDPOINT = endpoint
    return endpoint


def dc(path, project, values):
    """Always scope commands to an explicit standalone file and project."""
    return ["docker", "compose", "--env-file", str(path), "--project-name", project,
            "--file", str(path.parent / "compose.traefik.yml")], command_env(values)


def model_for(path, project, values):
    """Resolve Compose privately; never log its environment-bearing JSON."""
    args, env = dc(path, project, values)
    return json.loads(run(args + ["config", "--format", "json"], env=env))


def validate_model(model, directory):
    """Check the resolved isolation/migration contract before any lifecycle action."""
    project = model.get("name", "")
    if not (PROJECT.fullmatch(project) or RESTORE_PROJECT.fullmatch(project)):
        raise ValueError("The resolved Compose project must be explicitly scoped to feedback.")
    services = model.get("services", {})
    if set(services) != SERVICES or set(model.get("volumes", {})) != {"pgdata", "redisdata", "uploads"}:
        raise ValueError("Unexpected service or volume in deployment profile.")
    for logical, volume in model["volumes"].items():
        if volume.get("external") or volume.get("name") != f"{project}_{logical}" or volume.get("driver_opts") or volume.get("driver") not in (None, "local"):
            raise ValueError("Feedback volumes must be project-scoped local volumes without external or host-bind options.")
    expected_networks = {"postgres": {"data"}, "redis": {"data"}, "migrate": {"data"},
                         "api": {"data", "web", "egress"}, "dashboard": {"data", "web", "egress"},
                         "worker": {"data", "egress"}, "gateway": {"web", "proxy"}}
    networks = model.get("networks", {})
    if set(networks) != {"data", "web", "egress", "proxy"} or not networks["data"].get("internal") or not networks["web"].get("internal") or not networks["proxy"].get("external"):
        raise ValueError("The private data/web and external proxy network contract changed.")
    for logical in ("data", "web", "egress"):
        network = networks[logical]
        if network.get("external") or network.get("name") != f"{project}_{logical}" or network.get("driver_opts") or network.get("driver") not in (None, "bridge"):
            raise ValueError("Backend networks must be project-scoped bridge networks without external or custom host options.")
    expected_mounts = {
        "postgres": [("volume", "pgdata", "/var/lib/postgresql/data", False)],
        "redis": [("volume", "redisdata", "/data", False)],
        "api": [("volume", "uploads", "/var/lib/chorala/uploads", False)],
        "dashboard": [("volume", "uploads", "/var/lib/chorala/uploads", True)],
        "worker": [("volume", "uploads", "/var/lib/chorala/uploads", True)],
        "migrate": [],
        "gateway": [("bind", str(directory / "Caddyfile"), "/etc/caddy/Caddyfile", True)],
    }
    for name, service in services.items():
        if set(service.get("networks", {})) != expected_networks[name]:
            raise ValueError("A service is attached to an unexpected network.")
        if any(service.get(field) for field in ("build", "ports", "privileged", "network_mode", "pid", "ipc", "devices", "cap_add", "entrypoint")):
            raise ValueError("Builds, host exposure and elevated service options are forbidden.")
        if service.get("pull_policy") != "never" or not PIN.fullmatch(service.get("image", "")):
            raise ValueError("Every service must use an already-loaded immutable image.")
        if not service.get("mem_limit") or not service.get("cpus") or not service.get("pids_limit"):
            raise ValueError("Explicit service memory, CPU and process budgets are required.")
        if service.get("logging", {}).get("options") != {"max-file": "3", "max-size": "10m"}:
            raise ValueError("Bounded container logs are required.")
        actual_mounts = []
        for mount in service.get("volumes", []):
            source = mount.get("source")
            if mount.get("type") == "bind":
                if not isinstance(source, str):
                    raise ValueError("Unexpected host bind mount.")
                source = str(Path(source).resolve())
            actual_mounts.append((mount.get("type"), source, mount.get("target"), bool(mount.get("read_only"))))
        if actual_mounts != expected_mounts[name]:
            raise ValueError("Persistent storage mounts must match the exact service source, target and read-only contract.")
    if services["migrate"].get("image") != services["api"].get("image") or services["migrate"].get("command") != ["pnpm", "db:migrate"]:
        raise ValueError("Migration must use the matching API image and command.")
    redis_command = services["redis"].get("command", [])
    if "--appendonly" not in redis_command or "yes" not in redis_command or "--maxmemory-policy" not in redis_command or "noeviction" not in redis_command:
        raise ValueError("Redis queue persistence and no-eviction policy are required.")
    if any(services[name].get("labels", {}).get("traefik.enable") != ("true" if name == "gateway" else "false") for name in services):
        raise ValueError("Only the gateway may be exposed through Traefik.")
    if services["api"].get("depends_on", {}).get("migrate", {}).get("condition") != "service_completed_successfully":
        raise ValueError("API startup must wait for successful migration.")
    for name in ("api", "dashboard", "worker", "migrate"):
        env = services[name].get("environment", {})
        if env.get("CHORALA_ALLOW_SIGNUP") != "false" or env.get("CHORALA_DEPLOYMENT") != "selfhost":
            raise ValueError("Runtime self-host/closed-signup policy drifted.")
    return model


def local_images(values):
    """Validate loaded immutable references without pulling from a registry."""
    images = {}
    for name, key in IMAGE_KEYS.items():
        result = run(["docker", "image", "inspect", "--format", "{{.Id}} {{.Architecture}} {{.Os}}", values[key]]).split()
        if len(result) != 3 or not re.fullmatch(r"sha256:[0-9a-f]{64}", result[0]) or result[2] != "linux":
            raise ValueError("A required image is unavailable or unsupported.")
        if values[key].startswith("sha256:") and values[key] != result[0]:
            raise ValueError("Loaded image ID differs from the pinned reference.")
        images[name] = {"id": result[0], "architecture": result[1]}
    lock = HERE / "images.lock.json"
    if lock.is_file():
        expected = json.loads(lock.read_text())
        if expected.get("schema_version") != 1 or set(expected.get("images", {})) != set(IMAGE_KEYS):
            raise ValueError("Image provenance manifest is malformed.")
        for name, image in images.items():
            if expected["images"][name].get("reference") != image["id"]:
                raise ValueError("Loaded images do not match this deployment bundle's image manifest.")
    return images


def prepare(path, project):
    """Validate protected input and the exact standalone profile, without mutations."""
    path = Path(path).absolute()
    if path.name != ".env" or not (PROJECT.fullmatch(project) or RESTORE_PROJECT.fullmatch(project)):
        raise ValueError("Use an explicit satflux-feedback project and its protected deploy/.env file.")
    values = validate_settings(load_env(path))
    require_local_daemon()
    model = model_for(path, project, values)
    if model.get("name") != project or model.get("networks", {}).get("proxy", {}).get("name") != values["TRAEFIK_NETWORK"]:
        raise ValueError("Resolved project or proxy network differs from the explicitly reviewed inputs.")
    model = validate_model(model, path.parent.resolve())
    return path, values, model


def require_dedicated_proxy(values, project):
    """Never attach feedback to a shared Passbolt/database network by accident."""
    network = values["TRAEFIK_NETWORK"]
    edge = run(["docker", "inspect", "--type", "container", "--format", "{{.Id}}", values["TRAEFIK_CONTAINER"]]).strip()
    attached = json.loads(run(["docker", "network", "inspect", "--format", "{{json .Containers}}", network])) or {}
    if edge not in attached:
        raise ValueError("Selected Traefik is not attached to the dedicated ingress network.")
    for container in attached:
        if container == edge:
            continue
        role = run(["docker", "inspect", "--type", "container", "--format", '{{index .Config.Labels "com.docker.compose.project"}} {{index .Config.Labels "com.docker.compose.service"}}', container]).strip()
        if role != f"{project} gateway":
            raise ValueError("Ingress network contains another workload. Use a dedicated feedback/Traefik ingress network, not a Passbolt/database network.")


def preflight(args):
    """Check configuration, loaded images, current proxy identity and host headroom."""
    path, values, model = prepare(args.env_file, args.project)
    if args.config_only:
        print("PASS: protected configuration and image-only isolation/migration contract.")
        return
    images = local_images(values)
    command = [sys.executable, str(HERE / "inspect-target.py"), "--traefik-container", values["TRAEFIK_CONTAINER"]]
    if args.router_container:
        command += ["--router-container", args.router_container]
    report = json.loads(run(command))
    if not report["traefik_running"] or values["TRAEFIK_NETWORK"] not in report["networks"]:
        raise ValueError("The selected running Traefik is not attached to the selected proxy network.")
    require_dedicated_proxy(values, args.project)
    actual = set(report["trusted_proxy_cidrs"].get(values["TRAEFIK_NETWORK"], []))
    if set(values["CHORALA_TRUSTED_PROXY_CIDRS"].split()) != actual or not actual:
        raise ValueError("Trusted proxy addresses do not match current Traefik network addresses; inspect again.")
    if report["entrypoints"] and values["TRAEFIK_HTTPS_ENTRYPOINT"] not in report["entrypoints"]:
        raise ValueError("Configured entrypoint does not match observed HTTPS entrypoints.")
    if report["resolvers"] and values["TRAEFIK_CERT_RESOLVER"] not in report["resolvers"]:
        raise ValueError("Configured certificate resolver does not match observed resolvers.")
    if not report["entrypoints"] or not report["resolvers"]:
        raise ValueError("Proxy names could not be verified; inspect a known router with --router-container.")
    architecture = {"x86_64": "amd64", "aarch64": "arm64"}.get(report["docker"]["architecture"], report["docker"]["architecture"])
    if any(image["architecture"] != architecture for image in images.values()):
        raise ValueError("Loaded images do not match the target architecture.")
    capacity = report["capacity"]
    budget = sum(int(service["mem_limit"]) for name, service in model["services"].items() if name != "migrate") + 512 * 1024 ** 2
    if capacity["cpus"] < 2:
        raise ValueError("The prepared profile expects at least two vCPUs.")
    limited = capacity["memory_total_bytes"] < 7 * GIB or (capacity.get("memory_available_bytes") or 0) < budget
    if limited and not args.allow_small_host:
        raise ValueError("The prepared 8-GB operating profile lacks host headroom. Measure capacity; --allow-small-host is only for an explicitly approved controlled test.")
    print("PASS: local pinned images, proxy identity, architecture and deployment profile checks.")
    if limited:
        print("WARNING: small-host override used; this is not production capacity acceptance.")


def sha(path):
    """Hash files incrementally to avoid allocating backup payloads in memory."""
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def safe_members(archive, expected=None):
    """Reject traversal, links, special files, duplicates and unbounded metadata."""
    names, total = set(), 0
    for member in archive:
        path = PurePosixPath(member.name)
        name = str(path)
        if path.is_absolute() or ".." in path.parts or "\\" in member.name or member.issym() or member.islnk() or not (member.isfile() or member.isdir()) or name in names:
            raise ValueError("Backup archive contains unsafe or duplicate entries.")
        if expected is not None and (not member.isfile() or name not in expected):
            raise ValueError("Backup archive contains an unexpected entry.")
        names.add(name)
        total += member.size
        if member.mode & 0o7000 or member.size < 0 or len(names) > 100000 or total > 32 * GIB:
            raise ValueError("Backup archive exceeds the bounded restore profile.")
        yield member
    if expected is not None and names != expected:
        raise ValueError("Backup archive is incomplete.")


def volume_name(project, logical):
    """Resolve only a volume carrying this explicit Compose project/logical label."""
    result = run(["docker", "volume", "ls", "--filter", f"label=com.docker.compose.project={project}", "--filter", f"label=com.docker.compose.volume={logical}", "--format", "{{.Name}}"])
    names = result.splitlines()
    if len(names) != 1 or not NAME.fullmatch(names[0]):
        raise ValueError("Expected one exact project-scoped named volume.")
    return names[0]


def copy_volume(image, volume, target, restore=False):
    """Use a trusted loaded image with no network/privilege and one exact volume."""
    command = ["docker", "run", "--rm", "--network", "none", "--read-only", "--security-opt", "no-new-privileges", "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--memory", "128m", "--pids-limit", "32", "--entrypoint", "tar", "--mount", f"type=volume,source={volume},target=/snapshot" + ("" if restore else ",readonly"), image]
    if restore:
        # Fresh Redis directories are owned by Redis, not this root helper. FOWNER
        # permits restoring their timestamps/modes without granting chown or host access.
        command[-1:-1] = ["--cap-add", "FOWNER"]
        command.insert(2, "-i")
        with target.open("rb") as stream:
            run(command + ["--no-same-owner", "-xpf", "-", "-C", "/snapshot"], stdin=stream, timeout=3600)
    else:
        with target.open("xb") as stream:
            os.chmod(target, 0o600)
            run(command + ["-cpf", "-", "-C", "/snapshot", "."], stdout=stream, timeout=3600)


def backup(args):
    """Quiesce scoped writers and encrypt the complete paired set to a public key."""
    if not PROJECT.fullmatch(args.project):
        raise ValueError("Backup requires an explicit production, staging or QA project name.")
    output, recipient = Path(args.output).absolute(), Path(args.recipient_file).absolute()
    if output.resolve().is_relative_to(HERE.parent.resolve()):
        raise ValueError("Backup output and its protected plaintext scratch must stay outside the source or deployment bundle directory.")
    if output.exists() or output.is_symlink() or not output.parent.is_dir() or not recipient.is_file():
        raise ValueError("Use a new output path and an existing backup public-key file.")
    if output.suffix != ".gpg":
        raise ValueError("Encrypted backup output must end in .gpg.")
    path, values, _ = prepare(args.env_file, args.project)
    images = local_images(values)
    command, env = dc(path, args.project, values)
    running = set(run(command + ["ps", "--status", "running", "--services"], env=env).splitlines())
    if not running <= SERVICES or "postgres" not in running:
        raise ValueError("Expected the scoped PostgreSQL service to be running.")
    if "migrate" in running:
        raise ValueError("Wait for the one-shot migration to finish before taking a paired backup.")
    stopped = [name for name in WRITERS if name in running]
    redis_stopped = False
    try:
        if stopped:
            run(command + ["stop", "--timeout", "60"] + stopped, env=env, timeout=360)
        if "redis" in running:
            run(command + ["exec", "-T", "redis", "redis-cli", "SAVE"], env=env)
            redis_stopped = True
            run(command + ["stop", "--timeout", "60", "redis"], env=env, timeout=90)
        with tempfile.TemporaryDirectory(prefix=".chorala-backup-", dir=output.parent) as temporary:
            directory = Path(temporary)
            os.chmod(directory, 0o700)
            for source, name in ((path, "protected.env"), (path.parent / "compose.traefik.yml", "compose.traefik.yml"), (path.parent / "Caddyfile", "Caddyfile")):
                shutil.copyfile(source, directory / name)
                os.chmod(directory / name, 0o600)
            with (directory / "database.dump").open("xb") as stream:
                os.chmod(directory / "database.dump", 0o600)
                run(command + ["exec", "-T", "postgres", "pg_dump", "-U", "chorala", "-d", "chorala", "--format=custom"], env=env, stdout=stream, timeout=3600)
            for logical, name in (("uploads", "uploads.tar"), ("redisdata", "redis.tar")):
                copy_volume(images["api"]["id"], volume_name(args.project, logical), directory / name)
            metadata = {"backup_format": 1, "created_utc": datetime.now(timezone.utc).isoformat(), "project": args.project, "running_before": sorted(running), "images": images}
            (directory / "metadata.json").write_text(json.dumps(metadata, indent=2) + "\n")
            hashes = {name: sha(directory / name) for name in sorted(BACKUP_FILES)}
            (directory / "SHA256SUMS.json").write_text(json.dumps(hashes, indent=2) + "\n")
            archive_path = directory / "paired.tar"
            with tarfile.open(archive_path, "w") as archive:
                os.chmod(archive_path, 0o600)
                for name in sorted(BACKUP_FILES | {"SHA256SUMS.json"}):
                    archive.add(directory / name, arcname=name, recursive=False)
            keyring = directory / "gnupg"
            keyring.mkdir(mode=0o700)
            descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            try:
                with os.fdopen(descriptor, "wb") as encrypted, archive_path.open("rb") as plaintext:
                    run(["gpg", "--no-options", "--homedir", str(keyring), "--batch", "--trust-model", "always", "--recipient-file", str(recipient), "--encrypt", "--output", "-"], stdin=plaintext, stdout=encrypted, timeout=3600)
            except BaseException:
                output.unlink(missing_ok=True)
                raise
        print("Encrypted paired backup created. Keep the private decryption key off the serving host.")
        print("Encrypted backup SHA256:", sha(output))
    finally:
        # Never start a worker/service that was intentionally stopped beforehand.
        original_failure = sys.exc_info()[0] is not None
        restart_failed = False
        if redis_stopped:
            try:
                run(command + ["start", "redis"], env=env, timeout=90)
            except ValueError:
                restart_failed = True
        if stopped:
            try:
                run(command + ["start"] + list(reversed(stopped)), env=env, timeout=180)
            except ValueError:
                restart_failed = True
        if restart_failed:
            if original_failure:
                print("WARNING: resuming previously running services also failed; inspect this project's state before serving traffic.", file=sys.stderr)
            else:
                raise ValueError("Backup finished, but some previously running services could not resume; inspect this project's state.")


def recovery_env(original):
    """Preserve secret quoting/bytes; change only explicit recovery safety flags."""
    overrides = {"CHORALA_EMAIL_TRANSPORT": "none", "CHORALA_AI_PROVIDER": "none",
                 "CHORALA_BOOTSTRAP_EMAIL": "", "CHORALA_BOOTSTRAP_PASSWORD": "", "CHORALA_BOOTSTRAP_NAME": ""}
    seen, output = set(), []
    for line in original.splitlines(keepends=True):
        key = line.strip().partition("=")[0]
        if key in overrides:
            newline = "\r\n" if line.endswith("\r\n") else "\n"
            output.append(f"{key}={overrides[key]}{newline}")
            seen.add(key)
        else:
            output.append(line)
    text = "".join(output)
    if text and not text.endswith("\n"):
        text += "\n"
    return text + "".join(f"{key}={value}\n" for key, value in overrides.items() if key not in seen)


def restore(args):
    """Restore only into a new empty explicit project, never start application writers."""
    if not RESTORE_PROJECT.fullmatch(args.project) or not args.confirm_empty_target:
        raise ValueError("Restore requires an explicit satflux-feedback-restore-* project and --confirm-empty-target.")
    source, target = Path(args.archive).absolute(), Path(args.target_dir).absolute()
    require_private_file(source)
    require_local_daemon()
    if target.is_symlink() or (target.exists() and (not target.is_dir() or any(target.iterdir()))):
        raise ValueError("Restore target directory must be new or empty, not a symlink.")
    for resource in ("ps", "volume ls"):
        command = ["docker"] + resource.split() + (["--all"] if resource == "ps" else []) + ["--filter", f"label=com.docker.compose.project={args.project}", "--format", "{{.ID}}" if resource == "ps" else "{{.Name}}"]
        if run(command):
            raise ValueError("Restore project already has containers or volumes; nothing was changed.")
    existing_volumes = set(run(["docker", "volume", "ls", "--format", "{{.Name}}"] ).splitlines())
    if existing_volumes & {f"{args.project}_{name}" for name in ("pgdata", "redisdata", "uploads")}:
        raise ValueError("Restore target volume names already exist, even without Compose labels.")
    with tempfile.TemporaryDirectory(prefix="chorala-restore-") as temporary:
        directory = Path(temporary)
        os.chmod(directory, 0o700)
        with tarfile.open(source, "r:*") as archive:
            # Complete validation before extraction or any Docker mutation.
            members = list(safe_members(archive, BACKUP_FILES | {"SHA256SUMS.json"}))
            for member in members:
                with archive.extractfile(member) as stream, (directory / member.name).open("xb") as destination:
                    os.chmod(directory / member.name, 0o600)
                    shutil.copyfileobj(stream, destination)
        hashes = json.loads((directory / "SHA256SUMS.json").read_text())
        if set(hashes) != BACKUP_FILES or any(not re.fullmatch(r"[0-9a-f]{64}", value) or sha(directory / name) != value for name, value in hashes.items()):
            raise ValueError("Paired backup hashes do not match.")
        for name in ("compose.traefik.yml", "Caddyfile"):
            if (directory / name).read_bytes() != (HERE / name).read_bytes():
                raise ValueError("Use the matching trusted deployment bundle; archived Compose/proxy code is not executed.")
        metadata = json.loads((directory / "metadata.json").read_text())
        if metadata.get("backup_format") != 1:
            raise ValueError("Unsupported paired backup format.")
        for name in ("uploads.tar", "redis.tar"):
            with tarfile.open(directory / name, "r:*") as archive:
                list(safe_members(archive))
        values = validate_settings(load_env(directory / "protected.env"))
        images = local_images(values)
        if metadata.get("images") != images:
            raise ValueError("Restore image identity differs from the paired backup.")
        target.mkdir(mode=0o700, parents=False, exist_ok=True)
        os.chmod(target, 0o700)
        for name in ("compose.traefik.yml", "Caddyfile"):
            shutil.copyfile(HERE / name, target / name)
        config = target / ".env"
        original = (directory / "protected.env").read_bytes().decode("utf-8")
        config.write_bytes(recovery_env(original).encode("utf-8"))
        os.chmod(config, 0o600)
        _, values, model = prepare(config, args.project)
        command, env = dc(config, args.project, values)
        # Create only private data services and an unstarted API to provision its volume.
        run(command + ["up", "--detach", "--wait", "postgres", "redis"], env=env, timeout=180)
        # Compose create does not start dependencies; preserve existing data services
        # and never build or pull while provisioning the stopped API upload volume.
        run(command + ["create", "--no-recreate", "--no-build", "--pull", "never", "api"], env=env, timeout=90)
        run(command + ["stop", "--timeout", "60", "redis"], env=env, timeout=90)
        with (directory / "database.dump").open("rb") as stream:
            run(command + ["exec", "-T", "postgres", "pg_restore", "-U", "chorala", "-d", "chorala", "--exit-on-error", "--no-owner"], env=env, stdin=stream, timeout=3600)
        copy_volume(images["api"]["id"], volume_name(args.project, "uploads"), directory / "uploads.tar", restore=True)
        copy_volume(images["api"]["id"], volume_name(args.project, "redisdata"), directory / "redis.tar", restore=True)
        run(command + ["start", "redis"], env=env, timeout=90)
        print("Restored paired data into the new isolated project. Application, gateway and worker remain stopped.")
        print("Email/AI are disabled in restored configuration. Pending jobs may replay if the worker is later enabled; no exactly-once delivery guarantee is made.")


def main():
    """Expose only explicit preparation, scoped backup and empty-project restore CLIs."""
    mode = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] in {"backup", "restore"} else "preflight"
    parser = argparse.ArgumentParser(description=__doc__)
    if mode == "restore":
        parser.add_argument("--archive", required=True)
        parser.add_argument("--target-dir", required=True)
        parser.add_argument("--project", required=True)
        parser.add_argument("--confirm-empty-target", action="store_true")
    else:
        parser.add_argument("--env-file", required=True)
        parser.add_argument("--project", required=True)
        if mode == "backup":
            parser.add_argument("--output", required=True)
            parser.add_argument("--recipient-file", required=True)
        else:
            parser.add_argument("--config-only", action="store_true")
            parser.add_argument("--allow-small-host", action="store_true")
            parser.add_argument("--router-container")
    args = parser.parse_args(sys.argv[2:] if mode != "preflight" else None)
    try:
        {"preflight": preflight, "backup": backup, "restore": restore}[mode](args)
    except (ValueError, OSError, tarfile.TarError, KeyError, TypeError, json.JSONDecodeError) as exc:
        # Exceptions are deliberately static; never include subprocess or secret data.
        print(f"Operation refused: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
