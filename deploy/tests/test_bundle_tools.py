"""Regression checks for immutable bundles and protected configuration creation."""

import argparse
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
from unittest.mock import patch

DEPLOY = Path(__file__).resolve().parent.parent


def module(name, filename):
    spec = importlib.util.spec_from_file_location(name, DEPLOY / filename)
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


bundle = module("prepare_bundle", "prepare-bundle.py")
initialize = module("initialize_config", "init-config.py")


class BundleGuards(unittest.TestCase):
    def test_remote_context_takes_precedence_over_unix_host_and_is_rejected(self):
        with patch.dict(os.environ, {"DOCKER_CONTEXT": "remote", "DOCKER_HOST": "unix:///local.sock"}, clear=True):
            with patch.object(bundle, "_DOCKER_ENDPOINT", None), patch.object(bundle, "run", return_value=b"ssh://remote.example.invalid") as command:
                with self.assertRaises(ValueError):
                    bundle.docker("image", "save", "not-executed")
                self.assertEqual(command.call_args.args[0][3], "remote")

    def test_local_context_is_pinned_and_ambient_overrides_are_removed(self):
        with patch.dict(os.environ, {"DOCKER_CONTEXT": "local", "DOCKER_HOST": "tcp://wrong.invalid:2376", "PATH": "/bin"}, clear=True):
            with patch.object(bundle, "_DOCKER_ENDPOINT", None), patch.object(bundle, "run", return_value=b"unix:///local.sock"):
                self.assertEqual(bundle.docker("image", "inspect", "sha256:test")[:3], ["docker", "--host", "unix:///local.sock"])
                self.assertEqual(bundle.docker_env(), {"PATH": "/bin"})

    def test_mutable_image_name_is_refused(self):
        lock = json.loads((DEPLOY / "images.lock.json").read_text())
        lock["images"]["api"]["reference"] = "example/api:latest"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.json"
            path.write_text(json.dumps(lock))
            with self.assertRaises(ValueError):
                bundle.load_lock(path)

    def test_application_source_check_cannot_be_disabled(self):
        lock = json.loads((DEPLOY / "images.lock.json").read_text())
        lock["images"]["worker"]["verify_runtime_source"] = False
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "lock.json"
            path.write_text(json.dumps(lock))
            with self.assertRaises(ValueError):
                bundle.load_lock(path)

    def archive(self, name, kind=tarfile.REGTYPE):
        stream = io.BytesIO()
        with tarfile.open(fileobj=stream, mode="w") as handle:
            entry = tarfile.TarInfo(name)
            entry.type = kind
            if kind == tarfile.REGTYPE:
                entry.size = 4
                handle.addfile(entry, io.BytesIO(b"safe"))
            else:
                entry.linkname = "../outside"
                handle.addfile(entry)
        return stream.getvalue()

    def test_source_archive_rejects_traversal_and_links_before_extracting(self):
        for name, kind in [("../outside", tarfile.REGTYPE), ("/outside", tarfile.REGTYPE),
                           ("inside", tarfile.SYMTYPE), ("inside", tarfile.LNKTYPE)]:
            with self.subTest(name=name, kind=kind), tempfile.TemporaryDirectory() as directory:
                target = Path(directory) / "source"
                with self.assertRaises(ValueError):
                    bundle.extract_source(self.archive(name, kind), target)
                self.assertFalse(target.exists())

    def test_source_archive_extracts_only_regular_source_with_safe_mode(self):
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "source"
            bundle.extract_source(self.archive("app/source.txt"), target)
            self.assertEqual((target / "app/source.txt").read_bytes(), b"safe")
            self.assertEqual(stat.S_IMODE((target / "app/source.txt").stat().st_mode), 0o644)


class ConfigGuards(unittest.TestCase):
    def args(self, **values):
        return argparse.Namespace(network=values.get("network"), entrypoint=values.get("entrypoint"), resolver=values.get("resolver"))

    def report(self):
        return {"schema_version": 1, "traefik_running": True, "traefik_container": "synthetic-edge",
                "networks": ["synthetic-proxy"], "entrypoints": ["https"], "resolvers": ["synthetic-resolver"],
                "trusted_proxy_cidrs": {"synthetic-proxy": ["192.0.2.2/32", "2001:db8::2/128"]}}

    def lock(self):
        return json.loads((DEPLOY / "images.lock.json").read_text())

    def test_initializer_generates_independent_secrets_but_no_persistent_admin_password(self):
        first = initialize.settings(self.lock(), None, self.args())
        second = initialize.settings(self.lock(), None, self.args())
        self.assertEqual(len(first["CHORALA_DB_PASSWORD"]), 64)
        self.assertNotEqual(first["CHORALA_DB_PASSWORD"], first["CHORALA_AUTH_SECRET"])
        self.assertNotEqual(first["CHORALA_AUTH_SECRET"], second["CHORALA_AUTH_SECRET"])
        self.assertNotIn("CHORALA_BOOTSTRAP_PASSWORD", first)
        self.assertNotIn("TRAEFIK_NETWORK", first)

    def test_initializer_uses_observed_exact_proxy_addresses_and_literal_dotenv(self):
        values = initialize.settings(self.lock(), self.report(), self.args(network="synthetic-proxy"))
        self.assertEqual(values["TRAEFIK_NETWORK"], "synthetic-proxy")
        self.assertEqual(values["CHORALA_TRUSTED_PROXY_CIDRS"], "192.0.2.2/32 2001:db8::2/128")
        output = initialize.render((DEPLOY / ".env.example").read_text(), values)
        self.assertIn("CHORALA_TRUSTED_PROXY_CIDRS='192.0.2.2/32 2001:db8::2/128'", output)
        self.assertIn("CHORALA_BOOTSTRAP_PASSWORD=\n", output)

    def test_ambiguous_proxy_names_remain_unconfigured(self):
        report = self.report()
        report["networks"].append("other-network")
        values = initialize.settings(self.lock(), report, self.args())
        self.assertEqual(values["TRAEFIK_NETWORK"], "")
        self.assertNotIn("CHORALA_TRUSTED_PROXY_CIDRS", values)

    def test_even_a_single_observed_network_is_not_implicitly_approved_ingress(self):
        values = initialize.settings(self.lock(), self.report(), self.args())
        self.assertEqual(values["TRAEFIK_NETWORK"], "")
        self.assertNotIn("CHORALA_TRUSTED_PROXY_CIDRS", values)

    def test_unobserved_proxy_name_and_broad_trust_are_rejected(self):
        with self.assertRaises(ValueError):
            initialize.settings(self.lock(), self.report(), self.args(network="invented"))
        report = self.report()
        report["trusted_proxy_cidrs"]["synthetic-proxy"] = ["192.0.2.0/24"]
        with self.assertRaises(ValueError):
            initialize.settings(self.lock(), report, self.args(network="synthetic-proxy"))

    def test_existing_file_and_symlink_are_never_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / ".env"
            initialize.write_new(path, "protected")
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            with self.assertRaises(FileExistsError):
                initialize.write_new(path, "replacement")
            link = Path(directory) / "link"
            link.symlink_to(path)
            with self.assertRaises(FileExistsError):
                initialize.write_new(link, "replacement")
            self.assertEqual(path.read_text(), "protected")

    def test_dotenv_renderer_rejects_duplicate_keys_and_injected_lines(self):
        with self.assertRaises(ValueError):
            initialize.render("KEY=\nKEY=\n", {})
        with self.assertRaises(ValueError):
            initialize.render("KEY=\n", {"KEY": "value\nOTHER=bad"})


if __name__ == "__main__":
    unittest.main()
