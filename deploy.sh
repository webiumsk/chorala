#!/usr/bin/env bash
set -euo pipefail

# Keep the public entry point separate from protected runtime configuration.
exec bash "$(dirname -- "${BASH_SOURCE[0]}")/deploy/update.sh" "$@"
