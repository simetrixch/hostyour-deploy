#!/usr/bin/env bash
# Local YAML parsing, syntax checks, and last the suites of scripts/test.sh.
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

# The commit of ansiwise-cli the suites bind to.
yq -p=json -o=yaml e '.' "$ROOT/ci-sources.json" >/dev/null || fail 'ci-sources.json does not parse'

# The syntax of the files that are no suite.
node --check "$ROOT/scripts/ansiwise-run.mjs" || fail 'real CLI runner syntax'
node --check "$ROOT/scripts/move-machine.mjs" || fail 'machine move syntax'
bash -n "$ROOT/scripts/move-machine.sh" || fail 'machine move Bash syntax'
node --check "$ROOT/scripts/vault-policy-reaches.mjs" || fail 'vault policy reaches syntax'
python3 -I -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$ROOT/scripts/tenant-stage-proof.py" || fail 'tenant stage proof Python syntax'
bash -n "$ROOT/scripts/tenant-stage-proof.sh" || fail 'tenant stage proof Bash syntax'
bash -n "$ROOT/ansiwise/templates/forgejo-build-credentials.sh.tpl" || fail 'Forgejo credential producer Bash syntax'
bash -n "$ROOT/ansiwise/templates/forgejo-machine-user.sh.tpl" || fail 'Forgejo machine user producer Bash syntax'
bash -n "$ROOT/ansiwise/templates/forgejo-ssh-host-key.sh.tpl" || fail 'Forgejo SSH host key producer Bash syntax'
python3 -I -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$ROOT/ansiwise/templates/forgejo-plane-access.py.tpl" || fail 'Forgejo and Plane access module Python syntax'
node --check "$ROOT/scripts/forgejo-plane-access-fake.mjs" || fail 'Forgejo and Plane fake cluster syntax'
bash -n "$ROOT/ansiwise/templates/plane-sign-in.sh.tpl" || fail 'Plane sign-in producer Bash syntax'
python3 -I -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$ROOT/scripts/plane-orm-stand-in.py" || fail 'Plane ORM stand-in Python syntax'

# The suites, last, because they are the slowest part.
bash "$ROOT/scripts/test.sh" || fail 'a suite of scripts/test.sh is red, and its output stands above'
echo 'check: OK — every local check green'
