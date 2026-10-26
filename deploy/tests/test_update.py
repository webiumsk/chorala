"""Offline updater guards. All paths, containers, image IDs and data are synthetic."""

from copy import deepcopy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("chorala_update", Path(__file__).parents[1] / "update.py")
update = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(update)
REVISION = "1" * 40
PROJECT = "satflux-feedback-trial"
PIN = "sha256:" + "2" * 64


class FakeCommands:
    def __init__(self, target, containers):
        self.target, self.containers = target, containers
        self.calls = []
        self.fail_migration = False
        self.backup_archive = None

    def inspect(self, container):
        return self.containers[container.replace("test-", "")]

    def run(self, args, *, stdout=None, stdin=None, timeout=60, **unused):
        self.calls.append(args)
        for operation in ("stop", "start", "up"):
            if operation in args:
                for name in args[args.index(operation) + 1:]:
                    if name in self.containers:
                        self.containers[name]["State"]["Running"] = operation != "stop"
        if args[:3] == ["docker", "volume", "inspect"]:
            logical = args[-1].removeprefix(PROJECT + "_")
            return json.dumps([{"Driver": "local", "Options": None,
                                "Labels": {"com.docker.compose.project": PROJECT, "com.docker.compose.volume": logical}}])
        if "ps" in args:
            return "test-" + args[-1] + "\n"
        if "run" in args and "migrate" in args and self.fail_migration:
            raise update.Refused("Synthetic migration failure")
        if args[0] == "gpg":
            if "--show-keys" in args:
                return "pub:-:2048:1:synthetic::::::::e:\n"
            self.backup_archive = stdin.read()
            stdout.write(b"synthetic-encrypted-output")
        elif stdout is not None:
            stdout.write(b"synthetic-dump-or-volume-bytes")
        return ""


class UpdaterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.runtime = self.root / "runtime"
        self.runtime.mkdir()
        self.state = self.root / "state"
        self.state.mkdir(mode=0o700)
        self.env = self.runtime / "runtime.env"
        self.env.write_text("CHORALA_AUTH_SECRET=synthetic-only-auth-secret-for-tests\n")
        self.env.chmod(0o600)
        self.file = self.runtime / "compose.yml"
        self.file.write_text("# synthetic compose fixture\n")
        self.target = {"project": PROJECT, "working_dir": str(self.runtime), "compose_files": [str(self.file)],
                       "env_file": str(self.env), "anchor": "test-api", "override": None}
        self.model = {"name": PROJECT, "services": {name: {"image": PIN, "environment": {}} for name in update.SERVICES},
                      "volumes": {name: {"name": f"{PROJECT}_{name}"} for name in ("pgdata", "redisdata", "uploads")}}
        self.model["services"]["migrate"]["command"] = ["pnpm", "db:migrate"]
        self.containers = {}
        for name in update.SERVICES:
            self.containers[name] = {"Id": "test-" + name, "Image": PIN,
                "Config": {"Image": PIN, "Env": [], "Labels": {"com.docker.compose.project": PROJECT,
                    "com.docker.compose.service": name, "com.docker.compose.project.working_dir": str(self.runtime),
                    "com.docker.compose.project.config_files": str(self.file)}},
                "State": {"Running": name != "migrate", "ExitCode": 0}, "Mounts": []}
        for service, logical, destination in (("postgres", "pgdata", "/var/lib/postgresql/data"),
                ("redis", "redisdata", "/data"), ("api", "uploads", "/var/lib/chorala/uploads"),
                ("dashboard", "uploads", "/var/lib/chorala/uploads"), ("worker", "uploads", "/var/lib/chorala/uploads")):
            self.model["services"][service]["volumes"] = [{"type": "volume", "source": logical, "target": destination}]
            self.containers[service]["Mounts"] = [{"Type": "volume", "Name": f"{PROJECT}_{logical}", "Destination": destination, "RW": True}]
        self.command = FakeCommands(self.target, self.containers)
        self.recipient = self.root / "public.asc"
        self.recipient.write_text("synthetic public-key fixture")

    def tearDown(self):
        self.temporary.cleanup()

    def test_layout_refuses_extra_services_external_volumes_builds_and_changed_migrations(self):
        update.validate_model(self.model, PROJECT)
        cases = []
        value = deepcopy(self.model); value["services"]["unrelated"] = {}; cases.append(value)
        value = deepcopy(self.model); value["volumes"]["uploads"]["external"] = True; cases.append(value)
        value = deepcopy(self.model); value["services"]["api"]["build"] = "."; cases.append(value)
        value = deepcopy(self.model); value["services"]["migrate"]["command"] = ["pnpm", "db:seed"]; cases.append(value)
        value = deepcopy(self.model); value["services"]["api"]["volumes"][0]["type"] = "bind"; cases.append(value)
        for value in cases:
            with self.subTest(value=value):
                with self.assertRaises(update.Refused):
                    update.validate_model(value, PROJECT)

    def test_only_application_images_can_change(self):
        changed = deepcopy(self.model)
        for name in (*update.APPS, "migrate"):
            changed["services"][name]["image"] = "owned@" + PIN
            changed["services"][name]["pull_policy"] = "never"
        update.same_runtime(self.model, changed)
        for path, value in [("postgres", "unrelated-image"), ("api", "unrelated-env")]:
            wrong = deepcopy(changed)
            if path == "postgres":
                wrong["services"][path]["image"] = value
            else:
                wrong["services"][path]["environment"]["CHORALA_AUTH_SECRET"] = value
            with self.assertRaises(update.Refused):
                update.same_runtime(self.model, wrong)

    def test_discovery_preserves_operator_overlays_and_requires_explicit_environment(self):
        self.containers["api"]["Config"]["Labels"]["com.docker.compose.project.config_files"] += "," + str(self.file.with_name("trial.yml"))
        self.file.with_name("trial.yml").write_text("# synthetic overlay\n")
        with self.assertRaisesRegex(update.Refused, "--env-file"):
            update.discover(self.command, "test-api", self.state, None)
        target, _ = update.discover(self.command, "test-api", self.state, str(self.env))
        self.assertEqual(target["compose_files"], [str(self.file), str(self.file.with_name("trial.yml"))])

    def test_discovery_replaces_only_its_remembered_override(self):
        override = self.state / "images.compose.json"
        override.write_text("{}")
        saved = dict(self.target, override=str(override))
        update.write_private(self.state / "runtime.json", saved)
        self.containers["api"]["Config"]["Labels"]["com.docker.compose.project.config_files"] += "," + str(override)
        target, _ = update.discover(self.command, "test-api", self.state, None)
        self.assertEqual(target["compose_files"], [str(self.file)])
        self.assertEqual(target["override"], str(override))
        self.containers["api"]["Config"]["Labels"]["com.docker.compose.project.config_files"] = str(override)
        with self.assertRaises(update.Refused):
            update.discover(self.command, "test-api", self.state, None)

    def test_discovery_refuses_unprotected_configuration_and_state_inside_serving_tree(self):
        self.env.chmod(0o644)
        with self.assertRaises(update.Refused):
            update.discover(self.command, "test-api", self.state, str(self.env))
        self.env.chmod(0o600)
        with self.assertRaises(update.Refused):
            update.discover(self.command, "test-api", self.runtime / "unsafe-state", str(self.env))

    def test_physical_symlink_ancestor_cannot_hide_state_inside_serving_tree(self):
        alias = self.root / "runtime-alias"
        alias.symlink_to(self.runtime, target_is_directory=True)
        hidden = alias / "not-created-state"
        with self.assertRaisesRegex(update.Refused, "outside"):
            update.discover(self.command, "test-api", hidden, str(self.env))
        self.assertFalse(hidden.exists())

    def test_interrupted_phases_refuse_retry_without_claiming_safe_recovery(self):
        phases = ["quiescing", "backup-complete", "migrating", "starting-applications",
                  "failed-before-migration", "recovery-required-writers-stopped",
                  "recovery-required-stop-unconfirmed", "recovery-required-restore-unconfirmed"]
        for phase in phases:
            update.write_private(self.state / "last-operation.json", {"phase": phase})
            with self.subTest(phase=phase), self.assertRaises(update.Refused):
                update.require_reconciled_operation(self.state)
        for phase in ("complete", "failed-before-migration-restored"):
            update.write_private(self.state / "last-operation.json", {"phase": phase})
            update.require_reconciled_operation(self.state)

    def test_failed_atomic_state_write_removes_only_its_own_temporary_file(self):
        destination = self.state / "partial.json"
        with patch.object(update.json, "dump", side_effect=OSError("Synthetic disk full")):
            with self.assertRaises(OSError): update.write_private(destination, {"phase": "x"})
        self.assertFalse(destination.exists())
        self.assertFalse(destination.with_name("partial.json.new").exists())
        destination.with_name("partial.json.new").write_text("existing evidence")
        with self.assertRaises(OSError): update.write_private(destination, {"phase": "x"})
        self.assertEqual(destination.with_name("partial.json.new").read_text(), "existing evidence")

    def test_extra_dashboard_bind_is_refused_before_any_lifecycle(self):
        self.model["services"]["dashboard"]["volumes"].append({"type": "bind", "source": "/synthetic-host", "target": "/data"})
        with self.assertRaises(update.Refused): update.validate_model(self.model, PROJECT)
        self.assertFalse(self.command.calls)

    def test_current_container_and_volume_ownership_is_enforced(self):
        self.assertEqual(set(update.validate_containers(self.command, self.target, self.model)), update.SERVICES)
        self.containers["api"]["Mounts"][0]["Name"] = "another-project_uploads"
        with self.assertRaises(update.Refused):
            update.validate_containers(self.command, self.target, self.model)

    def test_changed_worker_environment_is_not_silently_activated(self):
        self.model["services"]["worker"]["environment"]["CHORALA_EMAIL_TRANSPORT"] = "smtp"
        self.containers["worker"]["Config"]["Env"] = ["CHORALA_EMAIL_TRANSPORT=none"]
        with self.assertRaises(update.Refused):
            update.validate_containers(self.command, self.target, self.model)

    def test_image_references_are_owned_digests_for_the_exact_revision(self):
        class Images:
            def __init__(self): self.calls = []; self.wrong = False
            def run(self, args, **unused):
                self.calls.append(args)
                if args[:3] == ["docker", "image", "inspect"]:
                    repo = args[-1].split(":sha-")[0]
                    return json.dumps([{"Config": {"Labels": {"org.opencontainers.image.revision": "0" * 40 if self.wrong else REVISION}},
                                        "Architecture": "amd64", "Os": "linux", "RepoDigests": [repo + "@" + PIN]}])
                return ""
        images = Images()
        resolved = update.deployment_images(images, REVISION)
        self.assertEqual(set(resolved), set(update.APPS))
        self.assertTrue(all(value.startswith("ghcr.io/webiumsk/chorala-") and ":sha-" not in value for value in resolved.values()))
        images.wrong = True
        with self.assertRaises(update.Refused):
            update.deployment_images(images, REVISION)

    def test_paired_backup_includes_all_configuration_database_uploads_and_redis(self):
        service_environment = self.runtime / "service-only.env"
        service_environment.write_text("SMTP_PASS=synthetic-service-only-value\n")
        service_environment.chmod(0o600)
        self.target["service_env_files"] = update.environment_files({"services": {
            "api": {"env_file": [{"path": str(service_environment), "required": True}]},
            "worker": {"env_file": [str(service_environment)]}}})
        result = update.paired_backup(self.command, self.target, self.containers, self.state, self.recipient)
        self.assertEqual(result.read_bytes(), b"synthetic-encrypted-output")
        self.assertEqual(result.stat().st_mode & 0o777, 0o600)
        with tarfile.open(fileobj=io.BytesIO(self.command.backup_archive)) as archive:
            members = set(archive.getnames())
            self.assertTrue({"database.dump", "uploads.tar", "redis.tar", "metadata.json", "SHA256SUMS.json"} <= members)
            metadata = json.load(archive.extractfile("metadata.json"))
            self.assertEqual(metadata["project"], PROJECT)
            self.assertEqual(len(metadata["configuration_paths"]), 3)
            backed_up = [archive.extractfile(name).read() for name in archive.getnames() if name.startswith("configuration/")]
            self.assertIn(service_environment.read_bytes(), backed_up)
        helpers = [args for args in self.command.calls if args[:2] == ["docker", "run"]]
        self.assertEqual(len(helpers), 2)
        self.assertTrue(all("--read-only" in args and "none" in args and "DAC_OVERRIDE" in args and "FOWNER" not in args for args in helpers))
        with self.assertRaises(update.Refused):
            update.paired_backup(self.command, self.target, self.containers, self.state, self.recipient)

    def test_distinct_service_environment_sources_must_be_private_and_resolved(self):
        with self.assertRaises(update.Refused):
            update.environment_files({"services": {"api": {"env_file": ["relative.env"]}}})
        exposed = self.runtime / "exposed.env"
        exposed.write_text("SYNTHETIC=test\n")
        exposed.chmod(0o644)
        with self.assertRaises(update.Refused):
            update.environment_files({"services": {"api": {"env_file": [{"path": str(exposed)}]}}})
        self.assertEqual(update.environment_files({"services": {"api": {"env_file": [{"path": str(self.root / 'optional.env'), "required": False}]}}}), [])

    def apply(self):
        override = self.state / "images.compose.json"
        override.write_text("{}")
        return update.apply_update(self.command, self.target, self.model, self.model, self.containers,
                                   override, REVISION, self.state, self.recipient, self.state)

    def test_success_migrates_before_applications_and_worker_after_http_readiness(self):
        with patch.object(update, "wait_healthy"):
            self.apply()
        calls = self.command.calls
        migration = next(i for i, args in enumerate(calls) if "run" in args and args[-1] == "migrate")
        application_starts = [(i, args) for i, args in enumerate(calls) if "up" in args]
        self.assertEqual(len(application_starts), 2)
        self.assertTrue(all(i > migration and "--no-deps" in args and "--no-build" in args for i, args in application_starts))
        self.assertEqual(application_starts[-1][1][-1], "worker")
        self.assertFalse(any(args[-1] in {"postgres", "redis", "gateway"} and "up" in args for args in calls))
        self.assertEqual(json.loads((self.state / "last-operation.json").read_text())["phase"], "complete")
        self.assertEqual(self.env.read_text(), "CHORALA_AUTH_SECRET=synthetic-only-auth-secret-for-tests\n")

    def test_backup_failure_resumes_only_previously_running_services(self):
        self.containers["worker"]["State"]["Running"] = False
        with patch.object(update, "paired_backup", side_effect=update.Refused("Synthetic backup refusal")):
            with self.assertRaises(update.Refused):
                self.apply()
        starts = [args[args.index("start") + 1:] for args in self.command.calls if "start" in args]
        self.assertFalse(any("worker" in names for names in starts))
        self.assertTrue(any("api" in names and "gateway" in names for names in starts))
        self.assertEqual(json.loads((self.state / "last-operation.json").read_text())["phase"], "failed-before-migration-restored")

    def test_state_disk_failure_cannot_prevent_pre_migration_resume(self):
        original_save = update.save_phase
        def state_failure(state, phase, *args):
            if phase.startswith("failed-") or phase.startswith("recovery-"):
                raise OSError("Synthetic state disk full")
            return original_save(state, phase, *args)
        with patch.object(update, "paired_backup", side_effect=update.Refused("Synthetic backup refusal")), patch.object(update, "save_phase", side_effect=state_failure):
            with self.assertRaises(update.Refused): self.apply()
        self.assertTrue(all(container["State"]["Running"] for name, container in self.containers.items() if name != "migrate"))

    def test_unconfirmed_stopping_after_migration_is_never_reported_as_stopped(self):
        original_run = self.command.run
        def fail_cleanup(args, **kwargs):
            if "stop" in args and len([call for call in self.command.calls if "stop" in call]) >= 2:
                raise update.Refused("Synthetic cleanup failure")
            return original_run(args, **kwargs)
        # Fail readiness after the applications have started; the cleanup command also fails.
        with patch.object(self.command, "run", side_effect=fail_cleanup), patch.object(update, "wait_healthy", side_effect=[None, update.Refused("Synthetic readiness failure")]), patch("sys.stderr", new_callable=io.StringIO) as output:
            with self.assertRaises(update.Refused): self.apply()
        self.assertEqual(json.loads((self.state / "last-operation.json").read_text())["phase"], "recovery-required-stop-unconfirmed")
        self.assertIn("could not be confirmed", output.getvalue())
        self.assertNotIn("writers are confirmed stopped", output.getvalue())

    def test_migration_failure_keeps_writers_stopped_and_records_recovery(self):
        self.command.fail_migration = True
        with patch.object(update, "wait_healthy"):
            with self.assertRaises(update.Refused):
                self.apply()
        self.assertFalse(any("up" in args for args in self.command.calls))
        starts = [args[args.index("start") + 1:] for args in self.command.calls if "start" in args]
        self.assertEqual(starts, [["redis"]])
        self.assertEqual(json.loads((self.state / "last-operation.json").read_text())["phase"], "recovery-required-writers-stopped")

    def test_subprocess_failures_do_not_expose_sensitive_output(self):
        failure = subprocess.CalledProcessError(1, ["test"], output=b"synthetic-secret", stderr=b"synthetic-secret")
        with patch.object(subprocess, "run", side_effect=failure):
            with self.assertRaises(update.Refused) as caught:
                update.Commands().run(["git", "test"])
        self.assertNotIn("synthetic-secret", str(caught.exception))

    def test_remote_docker_endpoint_is_rejected_and_local_endpoint_is_pinned(self):
        with patch.dict(os.environ, {"DOCKER_HOST": "tcp://remote:2375"}, clear=True):
            with self.assertRaises(update.Refused): update.Commands().local_endpoint()
        with patch.dict(os.environ, {"DOCKER_HOST": "unix:///synthetic.sock"}, clear=True):
            command = update.Commands()
            self.assertEqual(command.local_endpoint(), "unix:///synthetic.sock")
            os.environ["DOCKER_HOST"] = "tcp://changed:2375"
            self.assertEqual(command.local_endpoint(), "unix:///synthetic.sock")

    def test_help_is_nonmutating(self):
        with patch("sys.argv", ["update.py", "--help"]), patch("sys.stdout", new_callable=io.StringIO), self.assertRaises(SystemExit) as result:
            update.main()
        self.assertEqual(result.exception.code, 0)


if __name__ == "__main__":
    unittest.main()
