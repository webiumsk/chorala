#!/usr/bin/env bash
set -euo pipefail
# Never source protected configuration or execute a deployment from a moving Git ref.
exec python3 "$(dirname -- "${BASH_SOURCE[0]}")/update.py" "$@"
