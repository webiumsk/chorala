#!/usr/bin/env python3
"""Create a protected, non-overwriting runtime file without printing any secrets."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import sys

DIRECTORY = Path(__file__).resolve().parent
NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}\Z")
IMAGE = re.compile(r"sha256:[0-9a-f]{64}\Z")
IMAGE_VARIABLES = {
    "api": "CHORALA_API_IMAGE", "dashboard": "CHORALA_DASHBOARD_IMAGE",
    "worker": "CHORALA_WORKER_IMAGE", "postgres": "CHORALA_POSTGRES_IMAGE",
    "redis": "CHORALA_REDIS_IMAGE", "gateway": "CHORALA_GATEWAY_IMAGE",
}


def choose(value: str | None, choices: list[str], pattern: re.Pattern) -> str:
    """Use only an explicit selection or a single observed candidate."""
    if not isinstance(choices, list) or not all(isinstance(item, str) and pattern.fullmatch(item) for item in choices):
        raise ValueError("Target report contains invalid candidate names")
    if value is not None:
        if value not in choices:
            raise ValueError("Explicit proxy selection was not observed in the target report")
        return value
    return choices[0] if len(choices) == 1 else ""


def settings(lock: dict, report: dict | None, args: argparse.Namespace) -> dict[str, str]:
    """Generate independent random secrets and fill only verified public metadata."""
    if lock.get("schema_version") != 1 or set(lock.get("images", {})) != set(IMAGE_VARIABLES):
        raise ValueError("Invalid deployment image lock")
    values = {
        "CHORALA_DB_PASSWORD": secrets.token_hex(32),
        "CHORALA_AUTH_SECRET": secrets.token_hex(32),
    }
    for role, variable in IMAGE_VARIABLES.items():
        image = lock["images"][role]
        ref = image.get("reference", "")
        if image.get("variable") != variable or not IMAGE.fullmatch(ref):
            raise ValueError("Invalid immutable image reference in lock")
        values[variable] = ref
    if report is not None:
        if report.get("schema_version") != 1 or not report.get("traefik_running"):
            raise ValueError("Expected a current target inspection with a running Traefik")
        container = report.get("traefik_container", "")
        if not isinstance(container, str) or not NAME.fullmatch(container):
            raise ValueError("Invalid inspected proxy container name")
        values["TRAEFIK_CONTAINER"] = container
        # Membership alone does not prove an ingress purpose: the only network
        # could be Passbolt's private database network. Require an explicit choice.
        values["TRAEFIK_NETWORK"] = choose(args.network, report.get("networks", []), NAME) if args.network else ""
        values["TRAEFIK_HTTPS_ENTRYPOINT"] = choose(args.entrypoint, report.get("entrypoints", []), TOKEN)
        values["TRAEFIK_CERT_RESOLVER"] = choose(args.resolver, report.get("resolvers", []), TOKEN)
        if values["TRAEFIK_NETWORK"]:
            cidrs = report.get("trusted_proxy_cidrs", {}).get(values["TRAEFIK_NETWORK"], [])
            if not cidrs:
                raise ValueError("Selected proxy network has no inspected address")
            exact = []
            for value in cidrs:
                network = ipaddress.ip_network(value, strict=True)
                if network.prefixlen != network.max_prefixlen or network.network_address.is_unspecified or network.network_address.is_loopback:
                    raise ValueError("Proxy trust must identify exact inspected container addresses")
                exact.append(str(network))
            values["CHORALA_TRUSTED_PROXY_CIDRS"] = " ".join(exact)
    elif any([args.network, args.entrypoint, args.resolver]):
        raise ValueError("Proxy selections require a target report; names are not inferred")
    return values


def render(template: str, values: dict[str, str]) -> str:
    """Preserve template comments and encode generated values as literal dotenv text."""
    result = []
    seen = set()
    for line in template.splitlines():
        match = re.fullmatch(r"([A-Z][A-Z0-9_]*)=(.*)", line)
        if match:
            key = match[1]
            if key in seen:
                raise ValueError("Duplicate template key")
            seen.add(key)
            if key in values:
                value = values[key]
                if any(character in value for character in "\r\n\0'$"):
                    raise ValueError("Invalid generated dotenv value")
                line = f"{key}='{value}'" if " " in value else f"{key}={value}"
        result.append(line)
    if set(values) - seen:
        raise ValueError("Template is missing generated configuration keys")
    return "\n".join(result) + "\n"


def write_new(path: Path, content: str) -> None:
    """Create with owner-only mode and refuse existing files or symlinks."""
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as output:
        output.write(content)
        output.flush()
        os.fsync(output.fileno())


def main() -> None:
    """Initialize local settings only; never query Docker or start a service."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=DIRECTORY / ".env")
    parser.add_argument("--target-report", type=Path)
    parser.add_argument("--network")
    parser.add_argument("--entrypoint")
    parser.add_argument("--resolver")
    args = parser.parse_args()
    lock = json.loads((DIRECTORY / "images.lock.json").read_text())
    report = json.loads(args.target_report.read_text()) if args.target_report else None
    values = settings(lock, report, args)
    content = render((DIRECTORY / ".env.example").read_text(), values)
    write_new(args.output, content)
    print("Created protected configuration (0600). No values were printed. Review required proxy/admin/provider settings, then run preflight.")


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, TypeError, KeyError) as error:
        print(f"Configuration initialization refused: {error}", file=sys.stderr)
        sys.exit(1)
