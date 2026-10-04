#!/usr/bin/env bash
# Local YAML parsing. Registry binding tests run in GitHub Actions.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() { echo "check: FAIL — $1"; exit 1; }

command -v yq >/dev/null 2>&1 \
  || fail 'yq is not on PATH, and it is the YAML parser both halves of this check use'

# STEP 1 — every YAML file parses.
#
# The templates under ansiwise/templates are left out ON PURPOSE. Five of them are systemd units, a
# netplan file and a shell script. They are rendered onto a machine and are never read as YAML, so
# a parser would report them broken for being what they are.
files="$(find "$ROOT/ansiwise" -type f -name '*.yaml' | sort)"

roots=''
for file in "$ROOT"/ansiwise*.yaml; do
  [ -f "$file" ] || continue
  roots="$roots$file"$'\n'
done
[ -n "$roots" ] \
  || fail 'no ansiwise*.yaml stands at the root of this repository, and the engine reads out of it which plugins to load'
files="$files"$'\n'"$roots"

parsed=0
broken=0
while IFS= read -r file; do
  [ -n "$file" ] || continue
  parsed=$((parsed + 1))
  # yq writes its own message, naming the file and the line it stopped at. Only the count is added
  # here, so the person fixing the tree reads the parser and not a summary of it.
  yq e '.' "$file" >/dev/null || broken=$((broken + 1))
done <<EOF
$files
EOF

[ "$broken" -eq 0 ] || fail "$broken of $parsed YAML file(s) do not parse"
echo "check: $parsed YAML file(s) parse."

node --check "$ROOT/scripts/move-machine.mjs" || fail 'machine move syntax'
node --check "$ROOT/scripts/move-machine.test.mjs" || fail 'machine move check syntax'
bash -n "$ROOT/scripts/move-machine.sh" || fail 'machine move Bash syntax'
echo 'check: NOT RUN locally — scripts/move-machine.test.mjs; runs in public GitHub Actions.'

node --check "$ROOT/scripts/host-admission-floor.test.mjs" || fail 'host admission floor check syntax'
echo 'check: NOT RUN locally — scripts/host-admission-floor.test.mjs; runs in public GitHub Actions.'

python3 -c 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text()) for p in sys.argv[1:]]' "$ROOT/scripts/tenant-stage-proof.py" "$ROOT/scripts/tenant-stage-proof.test.py" || fail 'tenant stage proof Python syntax'
bash -n "$ROOT/scripts/tenant-stage-proof.sh" || fail 'tenant stage proof Bash syntax'
echo 'check: NOT RUN locally — scripts/tenant-stage-proof.test.py; public CI, except the explicit operator regression-first instruction.'

echo 'check: NOT RUN locally — dart test test/checks/config_validity_test.dart; runs in GitHub Actions via scripts/test.sh.'
echo 'check: OK — every local check green'
