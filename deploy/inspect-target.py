#!/usr/bin/env python3
"""Read-only host/proxy facts. Never output inspect data, env values or credentials."""

import argparse
import ipaddress
import json
import os
from pathlib import Path
import re
import subprocess
import sys

NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,127}\Z")
TOKEN = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,62}\Z")


def command(args):
    """Capture selected Docker fields privately and report only static failures."""
    try:
        return subprocess.run(args, check=True, text=True, capture_output=True, timeout=20).stdout.strip()
    except (OSError, subprocess.SubprocessError) as exc:
        raise ValueError("A read-only Docker query failed; no inspect output was logged.") from exc


def require_local_daemon():
    """Avoid comparing this machine's memory with a remote Docker endpoint."""
    context = os.environ.get("DOCKER_CONTEXT")
    if context:
        endpoint = command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}", context])
    elif os.environ.get("DOCKER_HOST"):
        endpoint = os.environ["DOCKER_HOST"]
    else:
        endpoint = command(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])
    if not endpoint.startswith("unix://"):
        raise ValueError("Run inspection on the Docker host using a local Unix-socket context.")


def host_memory():
    """Read capacity only, without exposing other host configuration."""
    values = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, _, value = line.partition(":")
        if key in {"MemTotal", "MemAvailable", "SwapTotal", "SwapFree"}:
            values[key] = int(value.strip().split()[0]) * 1024
    return values


def inspect(container, router_container=None):
    """Return only whitelisted capacity, proxy names and exact proxy address CIDRs."""
    if not NAME.fullmatch(container) or (router_container and not NAME.fullmatch(router_container)):
        raise ValueError("Container names must be simple Docker names.")
    require_local_daemon()
    raw = command(["docker", "info", "--format", "{{.ServerVersion}} {{.Architecture}} {{.OSType}} {{.NCPU}} {{.MemTotal}}"])
    version, architecture, operating_system, cpus, total = raw.split()
    running = command(["docker", "inspect", "--type", "container", "--format", "{{.State.Running}}", container]) == "true"
    networks = json.loads(command(["docker", "inspect", "--type", "container", "--format", "{{json .NetworkSettings.Networks}}", container]))
    # Cmd may include other operator arguments; only validated names leave this process.
    args = json.loads(command(["docker", "inspect", "--type", "container", "--format", "{{json .Config.Cmd}}", container])) or []
    entrypoints, resolvers = set(), set()
    for arg in args:
        match = re.fullmatch(r"--entrypoints\.([A-Za-z0-9_-]+)\.address=(:443(?:/tcp)?)", arg, re.I)
        if match and TOKEN.fullmatch(match[1]):
            entrypoints.add(match[1])
        match = re.match(r"--certificatesresolvers\.([A-Za-z0-9_-]+)\.", arg, re.I)
        if match and TOKEN.fullmatch(match[1]):
            resolvers.add(match[1])
    if router_container:
        labels = json.loads(command(["docker", "inspect", "--type", "container", "--format", "{{json .Config.Labels}}", router_container])) or {}
        for key, value in labels.items():
            if re.fullmatch(r"traefik\.http\.routers\.[A-Za-z0-9_-]+\.tls\.certresolver", key) and TOKEN.fullmatch(value):
                resolvers.add(value)
            if re.fullmatch(r"traefik\.http\.routers\.[A-Za-z0-9_-]+\.entrypoints", key):
                entrypoints.update(item for item in value.split(",") if TOKEN.fullmatch(item))
    selected_networks, network_details = [], {}
    cidrs = {}
    for name, network in sorted(networks.items()):
        if not NAME.fullmatch(name):
            continue
        addresses = []
        for field in ("IPAddress", "GlobalIPv6Address"):
            if network.get(field):
                address = ipaddress.ip_address(network[field])
                addresses.append(str(ipaddress.ip_network(f"{address}/{address.max_prefixlen}")))
        selected_networks.append(name)
        cidrs[name] = addresses
        summary = command(["docker", "network", "inspect", "--format", "{{.Id}} {{.Internal}} {{len .Containers}}", name]).split()
        if len(summary) != 3 or not re.fullmatch(r"[0-9a-f]{64}", summary[0]):
            raise ValueError("Unrecognized network metadata.")
        network_details[name] = {"id": summary[0], "internal": summary[1] == "true", "attached_containers": int(summary[2])}
    memory = host_memory()
    compose_version = command(["docker", "compose", "version", "--short"])
    if not re.fullmatch(r"v?\d+\.\d+\.\d+(?:[-+][A-Za-z0-9_.-]+)?", compose_version):
        raise ValueError("Unrecognized Docker Compose version output.")
    return {
        "schema_version": 1,
        "docker": {"version": version, "architecture": architecture, "os": operating_system},
        "compose_version": compose_version,
        "capacity": {"cpus": int(cpus), "memory_total_bytes": int(total), "memory_available_bytes": memory.get("MemAvailable"), "swap_total_bytes": memory.get("SwapTotal"), "swap_free_bytes": memory.get("SwapFree")},
        "traefik_container": container,
        "traefik_running": running,
        "networks": selected_networks,
        "network_details": network_details,
        "entrypoints": sorted(entrypoints),
        "resolvers": sorted(resolvers),
        "trusted_proxy_cidrs": cidrs,
        "warnings": [] if entrypoints and resolvers else ["Some proxy names were not visible in command arguments; supply --router-container for a known HTTPS router or inspect those names locally."],
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--traefik-container", default="passbolt-traefik-1")
    parser.add_argument("--router-container", help="Optional known application container; only HTTPS router name values are emitted.")
    args = parser.parse_args()
    try:
        print(json.dumps(inspect(args.traefik_container, args.router_container), indent=2))
    except (ValueError, OSError, KeyError, TypeError) as exc:
        print(f"Inspection failed: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
