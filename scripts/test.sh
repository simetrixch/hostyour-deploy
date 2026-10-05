#!/usr/bin/env bash
# Bind this tree to the shipped CLI registry on the GitHub Actions runner.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE='test/checks/config_validity_test.dart'
fail() { echo "test: FAIL — $1"; exit 1; }

# STEP 2 — every program binds to the registry the shipped binary carries.
#
# THE CLI CHECKOUT IS FOUND BY NAME, WITHOUT CASE. A checkout is regularly cased differently from
# the repository it came from, and an exact match reports a present one as absent.
#
# IT STANDS BESIDE THE MAIN CHECKOUT, and this check also runs from a worktree. An issue is worked
# in a worktree under ../.worktrees/<repo>/, whose own parent directory holds nothing but other
# worktrees, so a search beside the working tree finds no CLI checkout there. The common git
# directory is the main checkout's .git from either place, and it is what the neighbourhood is
# measured from.
common="$(git -C "$ROOT" rev-parse --git-common-dir)" \
  || fail 'this is not a git checkout, and the CLI checkout that holds the binding suite is found beside the main one'
case "$common" in
  /*|[A-Za-z]:*) ;;
  *) common="$ROOT/$common" ;;
esac
main_checkout="$(cd "$common/.." && pwd)"
cli=''
for entry in "$main_checkout"/../*; do
  [ -d "$entry" ] || continue
  [ "$(printf '%s' "${entry##*/}" | tr '[:upper:]' '[:lower:]')" = 'ansiwise-cli' ] || continue
  cli="$(cd "$entry" && pwd)"
  break
done
[ -n "$cli" ] \
  || fail "no ansiwise-cli checkout beside $main_checkout, and the suite that binds these programs to the shipped registry lives there"
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

node --test "$ROOT/scripts/move-machine.test.mjs" || fail 'paired machine move launchers'
node --test "$ROOT/scripts/tenant-stage-policy.test.mjs" || fail 'tenant stage Vault policy contract'
node --test "$ROOT/scripts/host-admission-floor.test.mjs" || fail 'host admission floor'
node --test "$ROOT/scripts/traefik-dashboard.test.mjs" || fail 'traefik dashboard off the web'
node --test "$ROOT/scripts/prune-unused-images.test.mjs" || fail 'prune unused images before the free-disk check'
node --test "$ROOT/scripts/kubelet-image-gc.test.mjs" || fail 'kubelet collects unused images'

python3 "$ROOT/scripts/tenant-stage-proof.test.py" || fail 'tenant stage permission proof'

echo 'test: OK — every check green'
