"""Negative deployment guards use synthetic strings and never mutate Docker."""

import importlib.util
import hashlib
import io
import json
from copy import deepcopy
from contextlib import redirect_stdout
from pathlib import Path
import tarfile
import tempfile
import subprocess
import sys
from types import SimpleNamespace
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / filename)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


P = module("deployment_preflight", "preflight.py")
I = module("deployment_inspection", "inspect-target.py")


def settings():
    return {
        "CHORALA_DEPLOYMENT": "selfhost", "CHORALA_DOMAIN": "feedback.satflux.io",
        "CHORALA_PUBLIC_URL": "https://feedback.satflux.io", "CHORALA_API_URL": "https://feedback.satflux.io",
        "CHORALA_WIDGET_CDN_URL": "https://feedback.satflux.io/widget.js", "CHORALA_ALLOW_SIGNUP": "false",
        "CHORALA_DB_PASSWORD": "d" * 64, "CHORALA_AUTH_SECRET": "a" * 64,
        **{key: "sha256:" + "1" * 64 for key in P.IMAGE_KEYS.values()},
        "TRAEFIK_CONTAINER": "synthetic-traefik", "TRAEFIK_NETWORK": "synthetic-proxy",
        "TRAEFIK_HTTPS_ENTRYPOINT": "synthetic-https", "TRAEFIK_CERT_RESOLVER": "synthetic-tls",
        "CHORALA_TRUSTED_PROXY_CIDRS": "192.0.2.4/32 2001:db8::1/128",
    }


def valid_model():
    project = "satflux-feedback-qa-model"
    connections = {"postgres": ["data"], "redis": ["data"], "migrate": ["data"],
                   "api": ["data", "web", "egress"], "dashboard": ["data", "web", "egress"],
                   "worker": ["data", "egress"], "gateway": ["web", "proxy"]}
    mounts = {"postgres": ("pgdata", "/var/lib/postgresql/data", False), "redis": ("redisdata", "/data", False),
              "api": ("uploads", "/var/lib/chorala/uploads", False), "dashboard": ("uploads", "/var/lib/chorala/uploads", True),
              "worker": ("uploads", "/var/lib/chorala/uploads", True)}
    services = {}
    for name, networks in connections.items():
        service = {"networks": dict.fromkeys(networks, {}), "image": "sha256:" + "1" * 64,
                   "pull_policy": "never", "mem_limit": 128 * 1024 ** 2, "cpus": 0.25, "pids_limit": 64,
                   "logging": {"options": {"max-file": "3", "max-size": "10m"}},
                   "labels": {"traefik.enable": "true" if name == "gateway" else "false"},
                   "environment": {"CHORALA_ALLOW_SIGNUP": "false", "CHORALA_DEPLOYMENT": "selfhost"}}
        if name in mounts:
            source, target, readonly = mounts[name]
            service["volumes"] = [{"type": "volume", "source": source, "target": target, "read_only": readonly}]
        services[name] = service
    services["gateway"]["volumes"] = [{"type": "bind", "source": str(ROOT / "Caddyfile"), "target": "/etc/caddy/Caddyfile", "read_only": True}]
    services["migrate"]["command"] = ["pnpm", "db:migrate"]
    services["redis"]["command"] = ["redis-server", "--appendonly", "yes", "--maxmemory-policy", "noeviction"]
    services["api"]["depends_on"] = {"migrate": {"condition": "service_completed_successfully"}}
    return {"name": project, "services": services,
            "volumes": {name: {"name": f"{project}_{name}"} for name in ("pgdata", "redisdata", "uploads")},
            "networks": {"data": {"name": f"{project}_data", "internal": True},
                         "web": {"name": f"{project}_web", "internal": True},
                         "egress": {"name": f"{project}_egress"},
                         "proxy": {"name": "synthetic-proxy", "external": True}}}


class IsolationModelTests(unittest.TestCase):
    def test_project_scoped_profile_with_exact_persistent_mounts_is_accepted(self):
        P.validate_model(valid_model(), ROOT)

    def test_external_unscoped_or_host_bound_volumes_are_rejected(self):
        for override in ({"external": True}, {"name": "passbolt-db-volume"}, {"driver_opts": {"type": "none", "o": "bind", "device": "/other-host-data"}}, {"driver": "external-storage"}):
            with self.subTest(override=override):
                model = valid_model()
                model["volumes"]["pgdata"].update(override)
                with self.assertRaises(ValueError):
                    P.validate_model(model, ROOT)

    def test_external_unscoped_or_host_backend_networks_are_rejected(self):
        for logical in ("data", "web", "egress"):
            for override in ({"external": True}, {"name": "passbolt-default"}, {"driver": "host"}, {"driver": "macvlan"}, {"driver_opts": {"parent": "eth0"}}):
                with self.subTest(logical=logical, override=override):
                    model = valid_model()
                    model["networks"][logical].update(override)
                    with self.assertRaises(ValueError):
                        P.validate_model(model, ROOT)

    def test_missing_wrong_target_or_changed_access_mounts_are_rejected(self):
        for name in ("postgres", "redis", "api", "dashboard", "worker", "gateway"):
            original = valid_model()
            for mutation in ("missing", "target", "access", "source"):
                with self.subTest(service=name, mutation=mutation):
                    model = deepcopy(original)
                    mount = model["services"][name]["volumes"][0]
                    if mutation == "missing":
                        model["services"][name]["volumes"] = []
                    elif mutation == "target":
                        mount["target"] = "/wrong-path"
                    elif mutation == "source":
                        mount["source"] = "other-volume" if mount["type"] == "volume" else "/etc/other.conf"
                    else:
                        mount["read_only"] = not mount["read_only"]
                    with self.assertRaises(ValueError):
                        P.validate_model(model, ROOT)

    def test_prepare_matches_explicit_project_and_inspected_proxy_inputs(self):
        for project, proxy in (("satflux-feedback-qa-other", "synthetic-proxy"), ("satflux-feedback-qa-model", "other-proxy")):
            model = valid_model()
            model["name"] = project
            model["networks"]["proxy"]["name"] = proxy
            with mock.patch.object(P, "load_env", return_value=settings()), mock.patch.object(P, "require_local_daemon"), mock.patch.object(P, "model_for", return_value=model), self.assertRaises(ValueError):
                P.prepare(ROOT / ".env", "satflux-feedback-qa-model")


class SettingsTests(unittest.TestCase):
    def test_exact_host_ids_and_exact_proxy_cidrs_are_supported(self):
        self.assertIs(P.validate_settings(values := settings()), values)

    def test_unknown_proxy_and_unsafe_configuration_fail_closed(self):
        for key, bad in [
            ("TRAEFIK_NETWORK", ""), ("TRAEFIK_HTTPS_ENTRYPOINT", "web,websecure"),
            ("TRAEFIK_CERT_RESOLVER", ""), ("CHORALA_API_IMAGE", "owned/api:latest"),
            ("CHORALA_PUBLIC_URL", "http://feedback.satflux.io"), ("CHORALA_ADMIN_HOSTS", "localhost"),
            ("CHORALA_ALLOW_SIGNUP", "true"), ("CHORALA_DB_PASSWORD", "short"),
            ("CHORALA_AUTH_SECRET", "short"), ("CHORALA_BOOTSTRAP_PASSWORD", "private-do-not-log"),
            ("CHORALA_TRUSTED_PROXY_CIDRS", "0.0.0.0/0"), ("CHORALA_TRUSTED_PROXY_CIDRS", "10.0.0.0/8"),
            ("CHORALA_TRUSTED_PROXY_CIDRS", "private_ranges"), ("CHORALA_TRUSTED_PROXY_CIDRS", "192.0.2.4/32 192.0.2.4/32"),
            ("CHORALA_AI_PROVIDER", "ollama"),
        ]:
            with self.subTest(key=key, bad=bad):
                values = settings()
                values[key] = bad
                with self.assertRaises(ValueError) as caught:
                    P.validate_settings(values)
                self.assertNotIn("private-do-not-log", str(caught.exception))

    def test_shared_secret_is_rejected(self):
        values = settings()
        values["CHORALA_AUTH_SECRET"] = values["CHORALA_DB_PASSWORD"]
        with self.assertRaises(ValueError):
            P.validate_settings(values)

    def test_literal_quoted_cidrs_are_parsed_without_execution(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("CHORALA_TRUSTED_PROXY_CIDRS='192.0.2.4/32 2001:db8::1/128'\n")
            path.chmod(0o600)
            self.assertEqual(P.load_env(path)["CHORALA_TRUSTED_PROXY_CIDRS"], "192.0.2.4/32 2001:db8::1/128")
            path.write_text("CHORALA_AUTH_SECRET=$(touch forbidden)\n")
            with self.assertRaises(ValueError):
                P.load_env(path)

    def test_duplicate_env_or_world_readable_secret_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_text("CHORALA_AUTH_SECRET=a\nCHORALA_AUTH_SECRET=b\n")
            path.chmod(0o600)
            with self.assertRaises(ValueError):
                P.load_env(path)
            path.write_text("CHORALA_AUTH_SECRET=a\n")
            path.chmod(0o644)
            with self.assertRaises(ValueError):
                P.load_env(path)

    def test_restore_keeps_quoted_secret_values_unchanged(self):
        original = "CHORALA_AUTH_SECRET='synthetic secret # with spaces and punctuation'\r\nSMTP_PASS='safe # password'\r\nCHORALA_EMAIL_TRANSPORT=smtp\r\n"
        result = P.recovery_env(original)
        self.assertIn("CHORALA_AUTH_SECRET='synthetic secret # with spaces and punctuation'\r\n", result)
        self.assertIn("SMTP_PASS='safe # password'\r\n", result)
        self.assertIn("CHORALA_EMAIL_TRANSPORT=none\r\n", result)
        self.assertIn("CHORALA_AI_PROVIDER=none\n", result)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            path.write_bytes(result.encode())
            path.chmod(0o600)
            self.assertEqual(P.load_env(path)["SMTP_PASS"], "safe # password")

    def test_docker_or_path_injection_and_unquoted_comments_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            for text in ("DOCKER_HOST=ssh://remote\n", "DOCKER_CONTEXT=remote\n", "COMPOSE_FILE=/other.yml\n", "PATH=/malicious\n", "SMTP_PASS=safe # changed\n"):
                path.write_text(text)
                path.chmod(0o600)
                with self.assertRaises(ValueError):
                    P.load_env(path)


class DockerContextTests(unittest.TestCase):
    def test_context_overrides_local_docker_host_in_both_tools(self):
        for value, function, target in [(I, I.require_local_daemon, "command"), (P, P.require_local_daemon, "run")]:
            with self.subTest(tool=value.__name__), mock.patch.object(P, "_DOCKER_ENDPOINT", None), mock.patch.dict("os.environ", {"DOCKER_CONTEXT": "remote", "DOCKER_HOST": "unix:///var/run/docker.sock"}, clear=True), mock.patch.object(value, target, return_value="ssh://synthetic-remote") as command:
                with self.assertRaises(ValueError):
                    function()
                self.assertEqual(command.call_args.args[0][-1], "remote")

    def test_unix_host_is_accepted_without_context(self):
        with mock.patch.object(P, "_DOCKER_ENDPOINT", None), mock.patch.dict("os.environ", {"DOCKER_HOST": "unix:///var/run/docker.sock"}, clear=True):
            I.require_local_daemon()
            P.require_local_daemon()

    def test_later_context_switch_cannot_redirect_docker_or_inspection(self):
        with mock.patch.object(P, "_DOCKER_ENDPOINT", None), mock.patch.dict("os.environ", {}, clear=True), mock.patch.object(P.subprocess, "run", return_value=subprocess.CompletedProcess([], 0, stdout=b"unix:///synthetic-verified.sock\n")) as operation:
            self.assertEqual(P.require_local_daemon(), "unix:///synthetic-verified.sock")
            with mock.patch.dict("os.environ", {"DOCKER_CONTEXT": "remote-now", "DOCKER_HOST": "ssh://unrelated-host"}, clear=True):
                P.run(["docker", "compose", "--project-name", "satflux-feedback-qa-context", "stop", "api"])
                command = operation.call_args.args[0]
                environment = operation.call_args.kwargs["env"]
                self.assertEqual(command[:3], ["docker", "--host", "unix:///synthetic-verified.sock"])
                self.assertNotIn("DOCKER_CONTEXT", environment)
                self.assertNotIn("DOCKER_HOST", environment)
                P.run([sys.executable, str(ROOT / "inspect-target.py")])
                environment = operation.call_args.kwargs["env"]
                self.assertEqual(environment["DOCKER_HOST"], "unix:///synthetic-verified.sock")
                self.assertNotIn("DOCKER_CONTEXT", environment)
            bootstrap = [call for call in operation.call_args_list if "context" in call.args[0]]
            self.assertEqual(len(bootstrap), 1)


class ArchiveTests(unittest.TestCase):
    def archive(self, entries):
        buffer = io.BytesIO()
        with tarfile.open(fileobj=buffer, mode="w") as archive:
            for name, kind in entries:
                entry = tarfile.TarInfo(name)
                entry.type = kind
                if kind == tarfile.REGTYPE:
                    entry.size = 1
                    archive.addfile(entry, io.BytesIO(b"x"))
                else:
                    entry.linkname = "../secret"
                    archive.addfile(entry)
        buffer.seek(0)
        return tarfile.open(fileobj=buffer, mode="r")

    def test_regular_snapshot_paths_are_supported(self):
        with self.archive([(".", tarfile.DIRTYPE), ("./project", tarfile.DIRTYPE), ("./project/image.png", tarfile.REGTYPE)]) as archive:
            self.assertEqual(len(list(P.safe_members(archive))), 3)

    def test_traversal_links_special_files_duplicates_and_incomplete_sets_fail(self):
        cases = [[("../secret", tarfile.REGTYPE)], [("/secret", tarfile.REGTYPE)],
                 [("link", tarfile.SYMTYPE)], [("link", tarfile.LNKTYPE)], [("device", tarfile.CHRTYPE)],
                 [("./same", tarfile.REGTYPE), ("same", tarfile.REGTYPE)]]
        for entries in cases:
            with self.subTest(entries=entries), self.archive(entries) as archive, self.assertRaises(ValueError):
                list(P.safe_members(archive))
        with self.archive([("database.dump", tarfile.REGTYPE)]) as archive, self.assertRaises(ValueError):
            list(P.safe_members(archive, P.BACKUP_FILES | {"SHA256SUMS.json"}))


class BackupFailureTests(unittest.TestCase):
    def test_checkout_or_symlink_parent_output_is_refused_before_any_operation(self):
        with tempfile.TemporaryDirectory() as directory:
            alias = Path(directory) / "checkout-alias"
            alias.symlink_to(ROOT.parent, target_is_directory=True)
            for output in (ROOT / "backup.tar.gpg", alias / "backup.tar.gpg"):
                args = SimpleNamespace(env_file="unused", project="satflux-feedback-qa-negative",
                                       output=str(output), recipient_file="unused")
                with self.subTest(output=output), mock.patch.object(P, "prepare") as prepare, mock.patch.object(P, "run") as operation, self.assertRaises(ValueError) as caught:
                    P.backup(args)
                self.assertIn("outside", str(caught.exception))
                prepare.assert_not_called()
                operation.assert_not_called()

    def test_failed_dump_or_encryption_resumes_only_previously_running_services(self):
        for failure in ("pg_dump", "gpg"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                path = Path(directory)
                env_file = path / ".env"
                env_file.write_text("CHORALA_AUTH_SECRET=synthetic-private-value\n")
                env_file.chmod(0o600)
                for name in ("compose.traefik.yml", "Caddyfile", "public.asc"):
                    (path / name).write_text("synthetic")
                args = SimpleNamespace(env_file=str(env_file), project="satflux-feedback-qa-negative",
                                       output=str(path / "backup.tar.gpg"), recipient_file=str(path / "public.asc"))
                calls = []

                def operation(command, **kwargs):
                    calls.append(command)
                    if "ps" in command:
                        return "postgres\nredis\napi\ndashboard\ngateway\n"  # worker deliberately stopped.
                    if failure == "pg_dump" and "pg_dump" in command:
                        raise ValueError("Synthetic dump failure.")
                    if failure == "gpg" and command[0] == "gpg":
                        raise ValueError("Synthetic encryption failure.")
                    if "pg_dump" in command:
                        kwargs["stdout"].write(b"synthetic database")
                    return ""

                def snapshot(image, volume, destination):
                    destination.write_bytes(b"synthetic volume")

                with mock.patch.object(P, "prepare", return_value=(env_file, settings(), {})), mock.patch.object(P, "local_images", return_value={"api": {"id": "sha256:" + "1" * 64}}), mock.patch.object(P, "run", side_effect=operation), mock.patch.object(P, "copy_volume", side_effect=snapshot), mock.patch.object(P, "volume_name", side_effect=lambda project, logical: logical):
                    with self.assertRaises(ValueError):
                        P.backup(args)
                starts = [command[command.index("start") + 1:] for command in calls if "start" in command]
                self.assertIn(["redis"], starts)
                resumed = {service for command in starts for service in command}
                self.assertEqual(resumed, {"redis", "api", "dashboard", "gateway"})
                self.assertNotIn("worker", resumed)
                self.assertFalse((path / "backup.tar.gpg").exists())


class IngressTests(unittest.TestCase):
    def test_other_workload_on_ingress_is_rejected(self):
        with mock.patch.object(P, "run", side_effect=["edge-id", '{"edge-id":{},"other-id":{}}', "passbolt database"]), self.assertRaises(ValueError):
            P.require_dedicated_proxy(settings(), "satflux-feedback")

    def test_only_edge_and_this_gateway_are_accepted(self):
        with mock.patch.object(P, "run", side_effect=["edge-id", '{"edge-id":{},"gateway-id":{}}', "satflux-feedback gateway"]):
            P.require_dedicated_proxy(settings(), "satflux-feedback")


class RestoreSequenceTests(unittest.TestCase):
    def test_restore_creates_but_never_starts_writers_or_recreates_existing_data_services(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            archive_path = directory / "paired.tar"
            target = directory / "new-restore"
            values = settings()
            values["CHORALA_TRUSTED_PROXY_CIDRS"] = "192.0.2.4/32"
            images = {name: {"id": "sha256:" + "1" * 64, "architecture": "amd64"} for name in P.IMAGE_KEYS}
            nested = io.BytesIO()
            with tarfile.open(fileobj=nested, mode="w") as archive:
                entry = tarfile.TarInfo(".")
                entry.type = tarfile.DIRTYPE
                entry.mode = 0o700
                archive.addfile(entry)
            files = {
                "protected.env": ("\n".join(f"{key}={value}" for key, value in values.items()) + "\n").encode(),
                "compose.traefik.yml": (ROOT / "compose.traefik.yml").read_bytes(),
                "Caddyfile": (ROOT / "Caddyfile").read_bytes(),
                "database.dump": b"synthetic database payload",
                "uploads.tar": nested.getvalue(), "redis.tar": nested.getvalue(),
                "metadata.json": json.dumps({"backup_format": 1, "images": images}).encode(),
            }
            files["SHA256SUMS.json"] = json.dumps({name: hashlib.sha256(data).hexdigest() for name, data in files.items()}).encode()
            with tarfile.open(archive_path, "w") as archive:
                for name, content in files.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(content)
                    entry.mode = 0o600
                    archive.addfile(entry, io.BytesIO(content))
            archive_path.chmod(0o600)
            args = SimpleNamespace(archive=str(archive_path), target_dir=str(target),
                                   project="satflux-feedback-restore-sequence", confirm_empty_target=True)
            operations = []

            def operation(command, **kwargs):
                operations.append(command)
                return ""

            def prepared(path, project):
                restored = P.validate_settings(P.load_env(path))
                self.assertEqual(restored["CHORALA_EMAIL_TRANSPORT"], "none")
                self.assertEqual(restored["CHORALA_AI_PROVIDER"], "none")
                return path, restored, {}

            with mock.patch.object(P, "require_local_daemon"), mock.patch.object(P, "local_images", return_value=images), mock.patch.object(P, "run", side_effect=operation), mock.patch.object(P, "prepare", side_effect=prepared), mock.patch.object(P, "copy_volume") as snapshots, mock.patch.object(P, "volume_name", side_effect=lambda project, logical: logical), redirect_stdout(io.StringIO()):
                P.restore(args)
            compose = [command for command in operations if command[:2] == ["docker", "compose"]]
            creation = [command[command.index("create"):] for command in compose if "create" in command]
            self.assertEqual(creation, [["create", "--no-recreate", "--no-build", "--pull", "never", "api"]])
            starts = [command[command.index("start"):] for command in compose if "start" in command]
            self.assertEqual(starts, [["start", "redis"]])
            ups = [command[command.index("up"):] for command in compose if "up" in command]
            self.assertEqual(ups, [["up", "--detach", "--wait", "postgres", "redis"]])
            self.assertFalse(any("--force-recreate" in command or "--no-deps" in command for command in compose))
            self.assertEqual(snapshots.call_count, 2)


if __name__ == "__main__":
    unittest.main()
