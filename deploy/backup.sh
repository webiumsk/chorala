#!/usr/bin/env bash
set -euo pipefail
# Never source operator .env or expand credentials through the shell.
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/preflight.py" backup "$@"
