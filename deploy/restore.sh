#!/usr/bin/env bash
set -euo pipefail
# Archive decryption happens offline; this command never reads a private key.
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/preflight.py" restore "$@"
