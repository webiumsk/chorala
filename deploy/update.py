#!/usr/bin/env python3
"""Update an existing Chorala deployment using exact, CI-built owned images."""

import argparse
from contextlib import nullcontext
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


REPOSITORY = "https://github.com/webiumsk/chorala.git"
SERVICES = {"api", "dashboard", "worker", "migrate", "postgres", "redis", "gateway"}
APPS = ("api", "dashboard", "worker")
WRITERS = ("gateway", "worker", "dashboard", "api")
NAME = re.compile(r"[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\Z")
SHA = re.compile(r"[0-9a-f]{40}\Z")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")


class Refused(Exception):
    """An operator-safe failure that never includes credentials or child output."""


def require(condition, message):
    if not condition:
        raise Refused(message)


def private_file(path):
    require(path.is_file() and not path.is_symlink(), "A required regular file is missing or linked.")
    require(not stat.S_IMODE(path.stat().st_mode) & 0o077,
            "Protect the runtime environment file with mode 0600.")


def safe_file(path):
    require(path.is_file() and not path.is_symlink(), "A required regular file is missing or linked.")
    return path


def digest_file(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def write_private(path, value):
    temporary = path.with_name(path.name + ".new")
    created = False
    try:
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        created = True
        with os.fdopen(descriptor, "w") as stream:
            json.dump(value, stream, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    except BaseException:
        if created:
            temporary.unlink(missing_ok=True)
        raise


class Commands:
    def __init__(self):
        self.endpoint = None

    def run(self, args, *, stdout=None, stdin=None, timeout=60, bootstrap=False):
        environment = dict(os.environ)
        if args[0] == "docker" and not bootstrap:
            args = ["docker", "--host", self.local_endpoint(), *args[1:]]
            environment.pop("DOCKER_HOST", None)
            environment.pop("DOCKER_CONTEXT", None)
        try:
            result = subprocess.run(args, stdin=stdin, stdout=stdout or subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=environment,
                                    timeout=timeout, check=True)
            return result.stdout.decode() if result.stdout is not None else ""
        except (OSError, subprocess.SubprocessError) as error:
            raise Refused("An operation failed; sensitive subprocess output was withheld.") from error

    def local_endpoint(self):
        if self.endpoint is None:
            if os.environ.get("DOCKER_CONTEXT"):
                endpoint = self.run(["docker", "context", "inspect", "--format",
                                     "{{.Endpoints.docker.Host}}", os.environ["DOCKER_CONTEXT"]], bootstrap=True).strip()
            elif os.environ.get("DOCKER_HOST"):
                endpoint = os.environ["DOCKER_HOST"]
            else:
                endpoint = self.run(["docker", "context", "inspect", "--format",
                                     "{{.Endpoints.docker.Host}}"], bootstrap=True).strip()
            require(endpoint.startswith("unix://"), "Remote Docker contexts are refused.")
            self.endpoint = endpoint
        return self.endpoint

    def inspect(self, container):
        rows = json.loads(self.run(["docker", "inspect", container]))
        require(len(rows) == 1, "Expected exactly one scoped container.")
        return rows[0]


def discover(command, anchor, state, env_file):
    require(not state.is_symlink(), "Updater state directory cannot be a symlink.")
    state = state.resolve()
    require(NAME.fullmatch(anchor), "Invalid API anchor container name.")
    container = command.inspect(anchor)
    labels = container.get("Config", {}).get("Labels", {}) or {}
    project = labels.get("com.docker.compose.project", "")
    require(NAME.fullmatch(project) and project.startswith("satflux-feedback"),
            "The API anchor is not a scoped Satflux feedback project.")
    require(labels.get("com.docker.compose.service") == "api", "The anchor must be this project's API.")
    working_value = Path(labels.get("com.docker.compose.project.working_dir", ""))
    require(working_value.is_absolute() and working_value.is_dir(), "Compose working-directory metadata is unavailable.")
    working = working_value.resolve()
    files = [Path(value) for value in labels.get("com.docker.compose.project.config_files", "").split(",") if value]
    require(files and all(path.is_absolute() for path in files) and len(set(files)) == len(files),
            "Compose file metadata is missing or ambiguous.")
    for path in files:
        safe_file(path)
    previous = state / "runtime.json"
    if previous.exists():
        private_file(previous)
    remembered = json.loads(previous.read_text()) if previous.is_file() else {}
    if remembered:
        require(remembered.get("project") == project and remembered.get("working_dir") == str(working),
                "Updater state belongs to another deployment.")
        expected = remembered["compose_files"] + ([remembered["override"]] if remembered.get("override") else [])
        require([str(path) for path in files] == expected, "The operator's Compose file list changed; inspect it before updating.")
        files = [Path(value) for value in remembered["compose_files"]]
    explicit = env_file or remembered.get("env_file") or labels.get("com.docker.compose.project.environment_file")
    require(explicit, "First run requires --env-file with the existing protected Compose environment path.")
    environment = Path(explicit).absolute()
    private_file(environment)
    boundaries = {working, *(path.parent.resolve() for path in files), Path(__file__).resolve().parent.parent}
    require(all(state != boundary and boundary not in state.parents for boundary in boundaries),
            "Keep updater state outside the serving directory/build context.")
    return {"project": project, "working_dir": str(working), "compose_files": [str(path) for path in files],
            "env_file": str(environment), "anchor": anchor, "override": remembered.get("override")}, container


def compose(target, override=None):
    args = ["docker", "compose", "--project-directory", target["working_dir"],
            "--env-file", target["env_file"], "--project-name", target["project"]]
    for path in target["compose_files"]:
        args += ["--file", path]
    if override:
        args += ["--file", str(override)]
    return args


def validate_model(model, project):
    require(model.get("name") == project and set(model.get("services", {})) == SERVICES,
            "The resolved Compose layout has unsupported services or another project.")
    volumes = model.get("volumes", {})
    require(set(volumes) == {"pgdata", "redisdata", "uploads"}, "Unexpected persistent-volume layout.")
    for name, volume in volumes.items():
        require(volume.get("name") == f"{project}_{name}" and not volume.get("external")
                and not volume.get("driver_opts") and volume.get("driver") in (None, "local"),
                "Persistent volumes must remain scoped local volumes.")
    for name, logical, mount_target in (("postgres", "pgdata", "/var/lib/postgresql/data"), ("redis", "redisdata", "/data"),
                                        ("api", "uploads", "/var/lib/chorala/uploads"),
                                        ("dashboard", "uploads", "/var/lib/chorala/uploads"),
                                        ("worker", "uploads", "/var/lib/chorala/uploads")):
        mounts = model["services"][name].get("volumes", [])
        require(len(mounts) == 1 and mounts[0].get("type") == "volume"
                and mounts[0].get("source") == logical and mounts[0].get("target") == mount_target,
                "A database/upload mount differs from the supported layout.")
    require(not model["services"]["migrate"].get("volumes"), "The migration service cannot acquire host/data mounts.")
    require(not any(model["services"][name].get("build") for name in SERVICES),
            "This updater requires image-only Compose files; serving-host builds are refused.")
    require(model["services"]["migrate"].get("command") == ["pnpm", "db:migrate"],
            "The migration command differs from the reviewed contract.")


def environment_files(unresolved):
    """Collect service env files separately from Compose interpolation input."""
    paths = []
    for service in unresolved.get("services", {}).values():
        for value in service.get("env_file", []):
            path = Path(value if isinstance(value, str) else value.get("path", ""))
            require(path.is_absolute(), "Compose did not resolve a service environment file path.")
            optional = isinstance(value, dict) and value.get("required") is False
            if optional and not path.exists():
                continue
            private_file(path)
            paths.append(str(path.resolve()))
    return list(dict.fromkeys(paths))


def validate_containers(command, target, model):
    containers = {}
    for service in SERVICES:
        ids = command.run(compose(target, target.get("override")) + ["ps", "--all", "--quiet", service]).split()
        require(len(ids) == 1, "Each scoped service must already have exactly one container.")
        container = command.inspect(ids[0])
        labels = container.get("Config", {}).get("Labels", {}) or {}
        require(labels.get("com.docker.compose.project") == target["project"]
                and labels.get("com.docker.compose.service") == service,
                "Container ownership differs from the selected deployment.")
        containers[service] = container
    require(containers["postgres"]["State"].get("Running"), "The scoped PostgreSQL service must be running.")
    require(not containers["migrate"]["State"].get("Running"), "Wait for the current migration to finish.")
    require(containers["migrate"]["State"].get("ExitCode") == 0, "The previous migration did not complete successfully.")
    if any(containers[service]["State"].get("Running") for service in APPS):
        require(containers["redis"]["State"].get("Running"), "Redis must be running before updating active applications.")
    for logical in ("pgdata", "redisdata", "uploads"):
        values = json.loads(command.run(["docker", "volume", "inspect", f"{target['project']}_{logical}"]))
        require(len(values) == 1 and values[0].get("Driver") == "local" and not values[0].get("Options"),
                "Persistent volumes must use the existing local driver without host mounts.")
        labels = values[0].get("Labels") or {}
        require(labels.get("com.docker.compose.project") == target["project"]
                and labels.get("com.docker.compose.volume") == logical,
                "Persistent volume ownership differs from the selected project.")
    for service, logical, destination in (("postgres", "pgdata", "/var/lib/postgresql/data"),
                                           ("redis", "redisdata", "/data"),
                                           ("api", "uploads", "/var/lib/chorala/uploads")):
        mounts = containers[service].get("Mounts", [])
        require(any(mount.get("Type") == "volume" and mount.get("Name") == f"{target['project']}_{logical}"
                    and mount.get("Destination") == destination for mount in mounts),
                "A running persistent mount differs from the project model.")
    for service in APPS:
        declared = model["services"][service]
        actual = containers[service]
        expected_mounts = {(model["volumes"][item["source"]]["name"], item["target"], not item.get("read_only", False))
                           for item in declared.get("volumes", [])}
        actual_mounts = {(item.get("Name"), item.get("Destination"), item.get("RW"))
                         for item in actual.get("Mounts", []) if item.get("Type") != "tmpfs"}
        require(expected_mounts == actual_mounts, "Application mounts differ from the running containers.")
        expected_tmpfs = {item.split(":", 1)[0] for item in declared.get("tmpfs", [])}
        actual_tmpfs = {item.get("Destination") for item in actual.get("Mounts", []) if item.get("Type") == "tmpfs"}
        require(expected_tmpfs == actual_tmpfs, "Application tmpfs mounts differ from the running containers.")
        host = actual.get("HostConfig", {})
        require(bool(declared.get("read_only")) == bool(host.get("ReadonlyRootfs"))
                and not declared.get("privileged") and not host.get("Privileged")
                and not declared.get("network_mode"), "Application rootfs or privilege settings differ from the running deployment.")
        expected_networks = {model["networks"][name]["name"] for name in declared.get("networks", {})}
        require(expected_networks == set(actual.get("NetworkSettings", {}).get("Networks", {})),
                "Application networks differ from the running deployment.")
        runtime_env = dict(value.split("=", 1) for value in containers[service]["Config"].get("Env", []) if "=" in value)
        for name, value in model["services"][service].get("environment", {}).items():
            require(runtime_env.get(name) == str(value), "The selected environment differs from a running application; inspect the runtime file.")
    return containers


def source_release(command, state):
    repository = state / "repository.git"
    require(not repository.is_symlink(), "Isolated repository state cannot be linked.")
    if not repository.exists():
        command.run(["git", "init", "--bare", str(repository)])
    require(repository.is_dir() and not repository.is_symlink(), "Isolated repository state is invalid.")
    command.run(["git", "-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never",
                 "--git-dir", str(repository), "fetch", "--no-tags", "--depth=1", REPOSITORY, "refs/heads/main"], timeout=180)
    revision = command.run(["git", "--git-dir", str(repository), "rev-parse", "FETCH_HEAD"]).strip()
    require(SHA.fullmatch(revision), "The owned main revision is not a full commit SHA.")
    directory = state / "releases" / revision
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    archive_path = directory / "source.tar"
    if not archive_path.exists():
        with archive_path.open("xb") as destination:
            command.run(["git", "--git-dir", str(repository), "archive", "--format=tar", revision], stdout=destination)
    return revision, directory


def deployment_images(command, revision):
    images = {}
    for service in APPS:
        repository = f"ghcr.io/webiumsk/chorala-{service}"
        reference = f"{repository}:sha-{revision}"
        try:
            command.run(["docker", "pull", reference], timeout=600)
        except Refused as error:
            raise Refused("The green main images are unavailable. Wait for Publish deployment images, or configure protected GHCR access, then retry.") from error
        rows = json.loads(command.run(["docker", "image", "inspect", reference]))
        require(len(rows) == 1, "Expected one exact deployment image.")
        image = rows[0]
        require((image.get("Config", {}).get("Labels") or {}).get("org.opencontainers.image.revision") == revision,
                "A pulled image does not identify the selected source revision.")
        require(image.get("Architecture") == "amd64" and image.get("Os") == "linux",
                "This deployment profile expects linux/amd64 images.")
        matches = [value for value in image.get("RepoDigests", []) if value.startswith(repository + "@sha256:")]
        require(len(matches) == 1 and DIGEST.fullmatch(matches[0].split("@", 1)[1]),
                "A pulled image has no unambiguous owned repository digest.")
        images[service] = matches[0]
    return images


def image_override(images):
    return {"services": {service: {"image": images["api" if service == "migrate" else service], "pull_policy": "never"}
                         for service in (*APPS, "migrate")}}


def same_runtime(before, after):
    def normalized(model):
        result = json.loads(json.dumps(model))
        for service in (*APPS, "migrate"):
            result["services"][service].pop("image", None)
            result["services"][service].pop("pull_policy", None)
        return result
    require(normalized(before) == normalized(after), "The update would change more than application image references.")


def save_phase(state, phase, revision, backup=None):
    write_private(state / "last-operation.json", {"phase": phase, "revision": revision,
                  "backup": str(backup) if backup else None,
                  "updated_utc": datetime.now(timezone.utc).isoformat()})


def require_reconciled_operation(state):
    previous = state / "last-operation.json"
    if previous.exists():
        private_file(previous)
        require(json.loads(previous.read_text()).get("phase") in {"complete", "failed-before-migration-restored"},
                "A prior update was interrupted or needs recovery; reconcile the selected deployment before another update.")


def validate_recipient(command, recipient, directory):
    with tempfile.TemporaryDirectory(prefix=".recipient-", dir=directory) as temporary:
        result = command.run(["gpg", "--no-options", "--homedir", temporary, "--batch",
                              "--with-colons", "--show-keys", str(recipient)])
        require(any(line.startswith("pub:") for line in result.splitlines())
                and not any(line.startswith("sec:") for line in result.splitlines()),
                "Use a public GPG encryption recipient, keeping its private key off the serving host.")


def paired_backup(command, target, containers, directory, recipient):
    output = directory / "paired-backup.tar.gpg"
    require(not output.exists(), "Backup output already exists; previous recovery evidence is preserved.")
    with tempfile.TemporaryDirectory(prefix=".paired-", dir=directory) as temporary:
        scratch = Path(temporary)
        os.chmod(scratch, 0o700)
        configuration = scratch / "configuration"
        configuration.mkdir(mode=0o700)
        config_files = [Path(target["env_file"]), *(Path(value) for value in target.get("service_env_files", [])),
                        *(Path(value) for value in target["compose_files"])]
        if target.get("override"):
            config_files.append(Path(target["override"]))
        # Record gateway file binds too; never archive sockets or whole host directories.
        for mount in containers["gateway"].get("Mounts", []):
            if mount.get("Type") == "bind":
                config_files.append(safe_file(Path(mount["Source"])))
        config_map = {}
        for number, path in enumerate(dict.fromkeys(config_files)):
            name = f"{number:03d}.config"
            shutil.copyfile(path, configuration / name)
            os.chmod(configuration / name, 0o600)
            config_map[name] = str(path)
        with (scratch / "database.dump").open("xb") as destination:
            command.run(["docker", "exec", containers["postgres"]["Id"], "sh", "-c",
                         'exec pg_dump -U "$POSTGRES_USER" -d "${POSTGRES_DB:-$POSTGRES_USER}" --format=custom'],
                        stdout=destination, timeout=3600)
        for logical, filename in (("uploads", "uploads.tar"), ("redisdata", "redis.tar")):
            with (scratch / filename).open("xb") as destination:
                command.run(["docker", "run", "--rm", "--network", "none", "--read-only",
                             "--memory", "256m", "--cpus", "0.5", "--pids-limit", "64",
                             "--cap-drop", "ALL", "--cap-add", "DAC_OVERRIDE", "--security-opt", "no-new-privileges:true",
                             "--mount", f"type=volume,src={target['project']}_{logical},dst=/volume,readonly",
                             "--entrypoint", "tar", containers["api"]["Image"], "-C", "/volume", "-cf", "-", "."],
                            stdout=destination, timeout=3600)
        metadata = {"update_backup_format": 1, "project": target["project"], "configuration_paths": config_map,
                    "running_before": [name for name, container in containers.items() if container["State"].get("Running")],
                    "images_before": {name: container["Image"] for name, container in containers.items()},
                    "volumes": {name: f"{target['project']}_{name}" for name in ("pgdata", "redisdata", "uploads")}}
        write_private(scratch / "metadata.json", metadata)
        files = sorted(path for path in scratch.rglob("*") if path.is_file())
        write_private(scratch / "SHA256SUMS.json", {str(path.relative_to(scratch)): digest_file(path) for path in files})
        archive_path = scratch / "paired.tar"
        with tarfile.open(archive_path, "w") as archive:
            for path in [*files, scratch / "SHA256SUMS.json"]:
                archive.add(path, arcname=path.relative_to(scratch), recursive=False)
        keyring = scratch / "gnupg"
        keyring.mkdir(mode=0o700)
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        try:
            with os.fdopen(descriptor, "wb") as encrypted, archive_path.open("rb") as plaintext:
                command.run(["gpg", "--no-options", "--homedir", str(keyring), "--batch", "--trust-model", "always",
                             "--recipient-file", str(recipient), "--encrypt", "--output", "-"],
                            stdin=plaintext, stdout=encrypted, timeout=3600)
        except BaseException:
            output.unlink(missing_ok=True)
            raise
    return output


def wait_healthy(command, container_id, seconds=180):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        container = command.inspect(container_id)
        state = container["State"]
        if state.get("Running") and state.get("Health", {}).get("Status") == "healthy":
            return
        require(state.get("Status") not in {"exited", "dead"}, "An updated service stopped before readiness.")
        time.sleep(2)
    raise Refused("An updated service did not become healthy before the timeout.")


def apply_update(command, target, before, after, containers, override, revision, directory, recipient, state):
    old_command = compose(target, target.get("override"))
    new_command = compose(target, override)
    running = {name for name, container in containers.items() if container["State"].get("Running")}
    stopped = [name for name in WRITERS if name in running]
    migration_started = False
    redis_stopped = False
    backup = None
    write_private(state / "last-context.json", {"project": target["project"],
                  "compose_files": target["compose_files"], "env_file": target["env_file"],
                  "previous_override": target.get("override"), "running_before": sorted(running),
                  "images_before": {name: container["Image"] for name, container in containers.items()}})
    try:
        save_phase(state, "quiescing", revision)
        if stopped:
            command.run(old_command + ["stop", "--timeout", "60", *stopped], timeout=360)
        if "redis" in running:
            command.run(old_command + ["exec", "-T", "redis", "redis-cli", "SAVE"])
            command.run(old_command + ["stop", "--timeout", "60", "redis"], timeout=90)
            redis_stopped = True
        attempt = directory / ("attempt-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ"))
        attempt.mkdir(mode=0o700)
        backup = paired_backup(command, target, containers, attempt, recipient)
        save_phase(state, "backup-complete", revision, backup)
        if redis_stopped:
            command.run(old_command + ["start", "redis"], timeout=90)
            redis_stopped = False
            wait_healthy(command, containers["redis"]["Id"])
        migration_started = True
        save_phase(state, "migrating", revision, backup)
        command.run(new_command + ["run", "--rm", "--no-deps", "--pull", "never", "migrate"], timeout=600)
        save_phase(state, "starting-applications", revision, backup)
        # Recreate only services that were already running. Data and gateway containers stay in place.
        applications = [name for name in ("api", "dashboard") if name in running]
        if applications:
            command.run(new_command + ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", *applications], timeout=300)
        for service in ("api", "dashboard"):
            if service in running:
                ids = command.run(new_command + ["ps", "--quiet", service]).split()
                require(len(ids) == 1, "An updated service is missing.")
                wait_healthy(command, ids[0])
                port, path = (8787, "/health") if service == "api" else (3015, "/login")
                probe = f"fetch('http://127.0.0.1:{port}{path}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
                command.run(["docker", "exec", ids[0], "node", "-e", probe], timeout=30)
        if "worker" in running:
            command.run(new_command + ["up", "--detach", "--no-deps", "--no-build", "--pull", "never", "worker"], timeout=120)
            ids = command.run(new_command + ["ps", "--quiet", "worker"]).split()
            require(len(ids) == 1 and command.inspect(ids[0])["State"].get("Running"), "The updated worker is not running.")
        if "gateway" in running:
            command.run(old_command + ["start", "gateway"], timeout=90)
        target["override"] = str(override)
        target["recipient_file"] = str(recipient)
        write_private(state / "runtime.json", target)
        save_phase(state, "complete", revision, backup)
        print("Deployment completed:", revision)
        print("Encrypted paired backup SHA256:", digest_file(backup))
    except BaseException:
        if redis_stopped:
            try:
                command.run(old_command + ["start", "redis"], timeout=90)
            except Refused:
                pass
        if not migration_started:
            # Cleanup must run even when the state disk is full or inaccessible.
            try:
                if stopped:
                    command.run(old_command + ["start", *reversed(stopped)], timeout=180)
            except Refused:
                pass
            try:
                restored = all(command.inspect(containers[name]["Id"])["State"].get("Running") for name in running)
            except Refused:
                restored = False
            try:
                save_phase(state, "failed-before-migration-restored" if restored else "recovery-required-restore-unconfirmed", revision, backup)
            except OSError:
                pass
            if not restored:
                print("Previous service state could not be confirmed after the failure; inspect this deployment before retrying.", file=sys.stderr)
        else:
            # A migration may have committed. Never guess that old code can read its schema.
            try:
                command.run(new_command + ["stop", "--timeout", "60", *WRITERS], timeout=360)
            except Refused:
                pass
            try:
                confirmed = all(not command.inspect(identifier)["State"].get("Running")
                                for name in WRITERS for identifier in command.run(new_command + ["ps", "--all", "--quiet", name]).split())
            except Refused:
                confirmed = False
            try:
                save_phase(state, "recovery-required-writers-stopped" if confirmed else "recovery-required-stop-unconfirmed", revision, backup)
            except OSError:
                pass
            print("Update failed after migration began. " +
                  ("Application writers are confirmed stopped; " if confirmed else "Stopping writers could not be confirmed; ") +
                  "inspect the paired backup and recover with matching schema/images.", file=sys.stderr)
        raise


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--anchor", default="satflux-feedback-trial-api-1")
    parser.add_argument("--state-dir", type=Path, default=Path("/var/lib/chorala-updater"))
    parser.add_argument("--env-file")
    parser.add_argument("--recipient-file")
    parser.add_argument("--check", action="store_true", help="Inspect local deployment only; no fetch, pull, stop or migration.")
    args = parser.parse_args()
    try:
        for executable in ("docker", "git", "gpg"):
            require(shutil.which(executable), "Docker, Git and GPG must already be installed.")
        supplied_state = args.state_dir.absolute()
        require(not supplied_state.is_symlink(), "Updater state directory cannot be a symlink.")
        state = supplied_state.resolve()
        if state.exists():
            require(state.is_dir() and state.stat().st_uid == os.geteuid()
                    and not stat.S_IMODE(state.stat().st_mode) & 0o077,
                    "Existing updater state must be an owner-only directory owned by the current operator.")
        # Discover physical boundaries before creating even the state directory.
        command = Commands()
        discover(command, args.anchor, state, args.env_file)
        if not state.exists() and not args.check:
            state.mkdir(mode=0o700, parents=True)
        lock_context = nullcontext(None) if args.check else (state / "update.lock").open("a+")
        with lock_context as lock:
            if lock is not None:
                os.chmod(state / "update.lock", 0o600)
                try:
                    fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                except BlockingIOError as error:
                    raise Refused("Another update is already running.") from error
            target, _ = discover(command, args.anchor, state, args.env_file)
            model = json.loads(command.run(compose(target, target.get("override")) + ["config", "--format", "json"]))
            validate_model(model, target["project"])
            unresolved = json.loads(command.run(compose(target, target.get("override")) + ["config", "--no-env-resolution", "--format", "json"]))
            target["service_env_files"] = environment_files(unresolved)
            containers = validate_containers(command, target, model)
            remembered = json.loads((state / "runtime.json").read_text()) if (state / "runtime.json").exists() else {}
            recipient_value = args.recipient_file or remembered.get("recipient_file")
            require(recipient_value, "First deployment requires --recipient-file with the public GPG backup recipient.")
            recipient = safe_file(Path(recipient_value).absolute())
            if args.check:
                print(json.dumps({"project": target["project"], "compose_files": len(target["compose_files"]),
                                  "services": sorted(SERVICES), "private_config": True,
                                  "mode": "check", "will_build_on_host": False}))
                return 0
            require_reconciled_operation(state)
            validate_recipient(command, recipient, state)
            revision, directory = source_release(command, state)
            images = deployment_images(command, revision)
            if all(containers[name]["Config"].get("Image") == images[name]
                   and containers[name]["State"].get("Running") for name in APPS):
                print("Already deployed:", revision)
                return 0
            override = directory / "images.compose.json"
            if override.exists():
                require(json.loads(override.read_text()) == image_override(images), "Previously resolved image digests changed; recovery evidence is preserved.")
            else:
                write_private(override, image_override(images))
            next_model = json.loads(command.run(compose(target, override) + ["config", "--format", "json"]))
            validate_model(next_model, target["project"])
            same_runtime(model, next_model)
            apply_update(command, target, model, next_model, containers, override,
                         revision, directory, recipient, state)
        return 0
    except (Refused, OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
        # Protected Compose/env, SQL and registry errors are intentionally not echoed.
        error = sys.exc_info()[1]
        print(str(error) if isinstance(error, Refused) else "Update refused; protected details were withheld.", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
