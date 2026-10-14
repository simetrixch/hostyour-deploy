#!/usr/bin/env bash
# Prints the root of the ansiwise-cli tree the registry binding suite runs in, and nothing else on standard output.
#   bash scripts/cli-checkout.sh <the suite's path in that tree>
# scripts/test.sh runs it; scripts/cli-checkout.test.mjs holds it to both of its answers.
#
# ON THE MASTER'S CI (CI_SOURCES_DIR is set) THE TREE IS THE COMMIT ci-sources.json PINS. The fetch task of the ci
# pipeline made a bare repository of that one commit at $CI_SOURCES_DIR/ansiwise-cli.git and mounted it read-only, so
# the commit is taken with `git archive` into a new directory: a worktree would write into the repository, and a
# branch head is not what the pin says. The pin is a full commit, because a branch or an abbreviation moves.
#
# ON A MACHINE THE CLI CHECKOUT IS FOUND BY NAME, WITHOUT CASE. A checkout is regularly cased differently from
# the repository it came from, and an exact match reports a present one as absent.
#
# IT STANDS BESIDE THE MAIN CHECKOUT, and this check also runs from a worktree. An issue is worked
# in a worktree under ../.worktrees/<repo>/, whose own parent directory holds nothing but other
# worktrees, so a search beside the working tree finds no CLI checkout there. The common git
# directory is the main checkout's .git from either place, and it is what the neighbourhood is
# measured from.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE="${1:?usage: cli-checkout.sh <the path of the suite in the ansiwise-cli tree>}"
fail() { echo "test: FAIL — $1" >&2; exit 1; }

if [ -n "${CI_SOURCES_DIR:-}" ]; then
  pin="$(yq -p=json -o=yaml e '.git["ansiwise-cli"] // ""' "$ROOT/ci-sources.json")" \
    || fail "ci-sources.json could not be read, so the commit of ansiwise-cli to bind these programs to is not known"
  [[ "$pin" =~ ^[0-9a-f]{40}$ ]] \
    || fail "ci-sources.json pins ansiwise-cli at '$pin', not a full commit (40 lowercase hex digits)"
  cli="$(mktemp -d)" || fail 'no temporary directory could be made'
  git --git-dir="$CI_SOURCES_DIR/ansiwise-cli.git" archive "$pin" | tar -x -C "$cli" \
    || fail "ansiwise-cli at $pin could not be read from $CI_SOURCES_DIR/ansiwise-cli.git"
else
  common="$(git -C "$ROOT" rev-parse --git-common-dir)" \
    || fail 'this is not a git checkout, and the CLI checkout that holds the binding suite is found beside the main one'
  case "$common" in
    /*) ;;
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
fi
[ -f "$cli/$SUITE" ] \
  || fail "$cli/$SUITE is missing, so these programs cannot be bound to a registry"
printf '%s\n' "$cli"
