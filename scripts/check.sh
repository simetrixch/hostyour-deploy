#!/usr/bin/env bash
# The checks this repository runs on itself, before every push.
#
#   bash scripts/check.sh
#
# Two steps, in this order, stopping at the first red one and naming it:
#
#   1. every YAML file in this tree parses
#   2. every program binds to the registry the shipped ansiwise binary carries
#
# WHY THE SECOND STEP RUNS IN ANOTHER CHECKOUT. A program file names steps, predicates and
# arguments. What those names may be is declared by the plugin packages, and only the CLI checkout
# composes the whole set a shipped binary carries. The suite there reads THIS tree and judges it
# against that set. A parser run here proves the files are YAML and proves nothing about whether a
# machine can execute them.
#
# A MISSING TOOL IS NAMED AND THE CHECK IS RED. A step that did not run is not a step that passed,
# and a green line over a step that never started is how a program no binary can execute reaches a
# machine.

set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE='test/checks/config_validity_test.dart'

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

# STEP 2 — every program binds to the registry the shipped binary carries.
#
# THE CLI CHECKOUT IS FOUND BY NAME, WITHOUT CASE. A checkout is regularly cased differently from
# the repository it came from, and an exact match reports a present one as absent.
cli=''
for entry in "$(dirname "$ROOT")"/*; do
  [ -d "$entry" ] || continue
  [ "$(printf '%s' "${entry##*/}" | tr '[:upper:]' '[:lower:]')" = 'ansiwise-cli' ] || continue
  cli="$entry"
  break
done
[ -n "$cli" ] \
  || fail 'no ansiwise-cli checkout beside this one, and the suite that binds these programs to the shipped registry lives there'
[ -f "$cli/$SUITE" ] \
  || fail "$cli/$SUITE is missing, so these programs cannot be bound to a registry"
command -v dart >/dev/null 2>&1 \
  || fail 'dart is not on PATH, and the suite that binds these programs to the shipped registry is a Dart test'

# THE TREE UNDER TEST IS NAMED, and is not left to the search the suite runs when nothing names
# one. That search takes the one directory near the CLI checkout that holds ansiwise/programs, and
# it refuses where a machine carries two. Naming this checkout makes the suite read the tree this
# check is about, on every machine.
#
# Dart reads a path the operating system understands. Under Git Bash the shell's own /d/... form is
# not that path, and the suite handed it would find no tree and skip.
installation="$ROOT"
if command -v cygpath >/dev/null 2>&1; then
  installation="$(cygpath -w "$ROOT")"
fi

# The output is captured so a SKIPPED suite can be told from a green one, then printed whole.
# Standard error is not captured and reaches the screen while the suite runs.
output="$(cd "$cli" && ANSIWISE_INSTALLATION="$installation" dart test "$SUITE")"
status=$?
printf '%s\n' "$output"
[ "$status" -eq 0 ] || fail "dart test $SUITE in $cli"

# A SKIPPED SUITE IS NOT A GREEN ONE. Where no installation tree is found, the suite skips itself
# and dart test still exits 0. That is honest of the suite, because a clone standing alone has no
# programs to judge. Here the suite was pointed at this tree, so a skip means these programs were
# never bound to anything.
case "$output" in
  *'All tests skipped'*|*'Skip:'*)
    fail "dart test $SUITE skipped its tests, so no program was bound to the shipped registry" ;;
esac

echo 'check: OK — every check green'
