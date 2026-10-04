#!/usr/bin/env bash
command -v python3 >/dev/null 2>&1 || { printf 'tenant-stage-proof: python3 is required\n' >&2; exit 69; }
exec python3 "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/tenant-stage-proof.py" "$@"
