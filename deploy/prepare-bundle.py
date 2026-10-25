#!/usr/bin/env python3
"""Prepare an offline bundle from immutable, source-verified local Docker images.

This command does not build, pull, tag, publish or deploy an image. Runtime source
and deployment-source revisions are recorded independently. Run on the build host,
not the serving VPS. Requires Python 3.10+, Git and Docker.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import sys
import tarfile


ROOT = Path(__file__).resolve().parent.parent
IMAGE_ID = re.compile(r"sha256:[0-9a-f]{64}\Z")
ROLES = {"api", "dashboard", "worker", "postgres", "redis", "gateway"}
_DOCKER_ENDPOINT: str | None = None
NODE_VERIFY = r"""
const fs=require('node:fs'), crypto=require('node:crypto');
const rows=JSON.parse(fs.readFileSync(0,'utf8'));
const bad=[];
for(const r of rows){
  try{
    const actual=crypto.createHash('sha256').update(fs.readFileSync('/app/'+r.path)).digest('hex');
    if(actual!==r.sha256)bad.push(r.path);
  }catch{bad.push(r.path);}
}
const operatorFiles=['.env','.env.production','.env.local','apps/api/.env','apps/dashboard/.env'];
const foundOperatorFile=operatorFiles.some(p=>fs.existsSync('/app/'+p));
process.stdout.write(JSON.stringify({checked:rows.length,mismatches:bad,node:process.version,operator_file_present:foundOperatorFile}));
"""


def docker_env() -> dict[str, str]:
    """Remove endpoint overrides after resolving their effective precedence."""
    return {key: value for key, value in os.environ.items() if key not in {"DOCKER_HOST", "DOCKER_CONTEXT"}}


def run(args: list[str], *, data: bytes | None = None) -> bytes:
    """Run an argument vector without a shell or exposing child diagnostic data."""
    result = subprocess.run(args, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=docker_env() if args[0] == "docker" else None)
    if result.returncode:
        raise RuntimeError(f"{args[0]} command failed (exit {result.returncode}); no child output was printed")
    return result.stdout


def docker(*args: str) -> list[str]:
    """Pin every Docker action to a verified local Unix endpoint."""
    global _DOCKER_ENDPOINT
    if _DOCKER_ENDPOINT is None:
        context = os.environ.get("DOCKER_CONTEXT")
        if context:
            endpoint = run(["docker", "context", "inspect", context, "--format", "{{.Endpoints.docker.Host}}"])
        elif os.environ.get("DOCKER_HOST"):
            endpoint = os.environ["DOCKER_HOST"].encode()
        else:
            endpoint = run(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
        _DOCKER_ENDPOINT = endpoint.decode().strip()
        if not _DOCKER_ENDPOINT.startswith("unix:///"):
            _DOCKER_ENDPOINT = None
            raise ValueError("Bundle preparation requires a local Unix-socket Docker endpoint")
    return ["docker", "--host", _DOCKER_ENDPOINT, *args]


def git(*args: str) -> bytes:
    """Read Git evidence from this checkout without changing it."""
    return run(["git", "-C", str(ROOT), *args])


def sha(path: Path) -> str:
    """Hash a file incrementally, including large saved-image archives."""
    result = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def load_lock(path: Path) -> dict:
    """Reject mutable image names and incomplete release metadata."""
    lock = json.loads(path.read_text())
    if lock.get("schema_version") != 1 or set(lock.get("images", {})) != ROLES:
        raise ValueError("Expected schema 1 and exactly six named image roles")
    if lock.get("platform") != "linux/amd64":
        raise ValueError("This reviewed bundle targets linux/amd64 only")
    source = lock.get("runtime_source", {})
    if not re.fullmatch(r"[0-9a-f]{40}", source.get("revision", "")):
        raise ValueError("Runtime source must identify an immutable Git revision")
    for role, image in lock["images"].items():
        if not IMAGE_ID.fullmatch(image.get("reference", "")):
            raise ValueError(f"Image role {role} must use a full local sha256 image ID")
        if not re.fullmatch(r"CHORALA_[A-Z_]+_IMAGE", image.get("variable", "")):
            raise ValueError("Invalid image configuration variable")
        if image.get("verify_runtime_source") is not (role in {"api", "dashboard", "worker"}):
            raise ValueError("Runtime source verification must cover every application image")
    return lock


def runtime_manifest(revision: str) -> list[dict]:
    """Hash committed application/package inputs while excluding test-only paths."""
    paths = git("ls-tree", "-r", "--name-only", revision).decode().splitlines()
    root_inputs = {"pnpm-lock.yaml", "pnpm-workspace.yaml", "package.json", "turbo.json", "tsconfig.json"}
    result = []
    for path in paths:
        source = path.startswith(("apps/", "packages/")) and not any(
            part in path for part in ("/test/", "/__tests__/", ".test.", ".spec.")
        )
        if source or path in root_inputs:
            result.append({"path": path, "sha256": hashlib.sha256(git("show", f"{revision}:{path}")).hexdigest()})
    if not result:
        raise ValueError("Runtime source manifest is empty")
    return result


def verify_images(lock: dict) -> dict:
    """Inspect only image identity/platform and run a sandboxed public-source checker."""
    rows = runtime_manifest(lock["runtime_source"]["revision"])
    locked = next(row["sha256"] for row in rows if row["path"] == "pnpm-lock.yaml")
    if locked != lock["runtime_source"].get("lockfile_sha256"):
        raise ValueError("Committed runtime lockfile differs from image lock metadata")
    reports = {}
    for role, image in lock["images"].items():
        ref = image["reference"]
        # Fixed fields avoid reading image environment, commands or credentials.
        fields = run(docker("image", "inspect", ref, "--format", "{{.Id}} {{.Os}}/{{.Architecture}}")).decode().strip().split()
        if fields != [ref, lock["platform"]]:
            raise ValueError(f"Image identity or platform differs for {role}")
        report = {"image_id": ref, "platform": fields[1]}
        if image["verify_runtime_source"]:
            result = json.loads(run(docker(
                "run", "--rm", "-i", "--network", "none", "--read-only",
                "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--user", "65534:65534",
                "--entrypoint", "node", ref, "-e", NODE_VERIFY,
            ), data=json.dumps(rows).encode()))
            if result["mismatches"] or result["operator_file_present"] or result["node"] != lock["runtime_source"]["node_version"]:
                raise ValueError(f"Embedded runtime source verification failed for {role}")
            report.update({"checked_source_files": result["checked"], "node": result["node"],
                           "runtime_manifest_sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()})
        reports[role] = report
    return reports


def extract_source(archive: bytes, target: Path) -> None:
    """Extract only regular committed files and directories, never links or traversal."""
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:") as source:
        members = source.getmembers()
        for member in members:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts or not (member.isfile() or member.isdir()):
                raise ValueError("Source archive contains an unsafe entry")
        target.mkdir()
        for member in members:
            destination = target / member.name
            if member.isdir():
                destination.mkdir(parents=True, exist_ok=True)
            else:
                destination.parent.mkdir(parents=True, exist_ok=True)
                data = source.extractfile(member)
                if data is None:
                    raise ValueError("Missing regular-file archive data")
                with destination.open("xb") as output:
                    shutil.copyfileobj(data, output)
                destination.chmod(0o755 if member.mode & 0o111 else 0o644)


def save_images(references: list[str], destination: Path) -> None:
    """Save the selected IDs once with shared layers and no registry communication."""
    with destination.open("xb") as raw:
        with gzip.GzipFile(filename="", fileobj=raw, mode="wb", mtime=0, compresslevel=1) as compressed:
            process = subprocess.Popen(docker("image", "save", *sorted(set(references))),
                                       stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=docker_env())
            try:
                assert process.stdout is not None
                shutil.copyfileobj(process.stdout, compressed, length=1024 * 1024)
                process.stdout.close()
                if process.wait():
                    raise RuntimeError("Docker image save failed")
            finally:
                if process.poll() is None:
                    process.terminate()
                    process.wait()


def main() -> None:
    """Build a new, checksummed, source-bearing directory without operator secrets."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--lock", type=Path, default=Path(__file__).with_name("images.lock.json"))
    parser.add_argument("--output", type=Path)
    parser.add_argument("--verify-images-only", action="store_true")
    args = parser.parse_args()
    lock = load_lock(args.lock)
    proof = verify_images(lock)
    if args.verify_images_only:
        print(json.dumps({"status": "verified", "runtime_source": lock["runtime_source"], "images": proof}, indent=2))
        return
    if args.output is None:
        parser.error("--output is required unless --verify-images-only is used")
    output = args.output.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError("Bundle output must be outside the checkout/build context")
    if output.exists():
        raise ValueError("Bundle output must not already exist")
    if git("status", "--porcelain", "--untracked-files=all").strip():
        raise ValueError("Commit and review the complete deployment source before packaging")
    revision = git("rev-parse", "HEAD").decode().strip()
    committed_lock = json.loads(git("show", f"{revision}:deploy/images.lock.json"))
    if committed_lock != lock:
        raise ValueError("Bundle lock must equal the committed deployment image lock")
    output.mkdir(parents=True, mode=0o700)
    extract_source(git("archive", "--format=tar", revision), output / "source")
    save_images([image["reference"] for image in lock["images"].values()], output / "images.tar.gz")
    manifest = {"schema_version": 1, "deployment_source_revision": revision,
                "runtime_source": lock["runtime_source"], "platform": lock["platform"], "images": proof}
    (output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    lines = [f"{sha(path)}  {path.relative_to(output).as_posix()}" for path in sorted(output.rglob("*")) if path.is_file()]
    (output / "SHA256SUMS").write_text("\n".join(lines) + "\n")
    print("Prepared offline bundle. Verify SHA256SUMS, read source/docs/DEPLOYMENT_SATFLUX.md, then load images explicitly.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"Bundle preparation refused: {error}", file=sys.stderr)
        sys.exit(1)
