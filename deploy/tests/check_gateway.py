#!/usr/bin/env python3
"""Check real Caddy adaptation using the pinned offline image; no networking."""

import importlib.util
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("deployment_preflight", ROOT / "preflight.py")
preflight = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preflight)


def main():
    preflight.require_local_daemon()
    image = json.loads((ROOT / "images.lock.json").read_text())["images"]["gateway"]["reference"]
    command = ["docker", "run", "--rm", "--pull", "never", "--network", "none", "--read-only",
               "--memory", "128m", "--pids-limit", "32", "--env", "CHORALA_TRUSTED_PROXY_CIDRS=192.0.2.4/32",
               "--mount", f"type=bind,source={ROOT / 'Caddyfile'},target=/etc/caddy/Caddyfile,readonly",
               image, "caddy", "adapt", "--config", "/etc/caddy/Caddyfile"]
    config = json.loads(preflight.run(command, timeout=30))
    server = config["apps"]["http"]["servers"]["srv0"]
    routes = server["routes"][0]["handle"][0]["routes"]
    first = routes[0]
    assert first["match"] == [{"not": [{"host": ["feedback.satflux.io"]}]}]
    assert first["handle"][0]["handler"] == "static_response"
    assert first["handle"][0]["status_code"] == 421
    assert server["trusted_proxies"]["ranges"] == ["192.0.2.4/32"]
    assert server["trusted_proxies_strict"] == 1
    assert config["admin"]["disabled"] is True
    proxies = [route["handle"][0]["routes"][0]["handle"][0] for route in routes if route.get("group")]
    assert len(proxies) == 2
    for proxy in proxies:
        headers = proxy["headers"]["request"]["set"]
        assert headers["Host"] == ["feedback.satflux.io"]
        assert headers["X-Forwarded-Proto"] == ["https"]
        assert headers["X-Forwarded-For"] == ["{http.vars.client_ip}"]
    print("PASS: real pinned Caddy adapter puts unknown-host denial first and sanitizes forwarding metadata.")


if __name__ == "__main__":
    main()
