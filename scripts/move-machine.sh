#!/usr/bin/env bash
command -v node >/dev/null 2>&1 || { printf 'domain-move: node is required\n' >&2; exit 69; }
exec node "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/move-machine.mjs" "$@"
