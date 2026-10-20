#!/usr/bin/env bash
# Prints the root of the ansiwise-cli tree the registry binding suite runs in, and nothing else on standard output.
#   bash scripts/cli-checkout.sh <the suite's path in that tree>
# scripts/test.sh runs it; scripts/cli-checkout.test.mjs holds it to its answers.
#
# THE TREE IS THE COMMIT ci-sources.json PINS, taken with `git archive` out of the ansiwise-cli checkout into a new
# directory: what that checkout stands on is not what the pin says, and a worktree would write into it. The pin is a
# full commit, because a branch or an abbreviation moves. The caller removes the directory.
#
# THE CLI CHECKOUT IS FOUND BY NAME, WITHOUT CASE. A checkout is regularly cased differently from
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

pin="$(yq -p=json -o=yaml e '.git["ansiwise-cli"] // ""' "$ROOT/ci-sources.json")" \
  || fail "ci-sources.json could not be read, so the commit of ansiwise-cli to bind these programs to is not known"
[[ "$pin" =~ ^[0-9a-f]{40}$ ]] \
  || fail "ci-sources.json pins ansiwise-cli at '$pin', not a full commit (40 lowercase hex digits)"
common="$(git -C "$ROOT" rev-parse --git-common-dir)" \
  || fail 'this is not a git checkout, and the CLI checkout that holds the binding suite is found beside the main one'
case "$common" in
  /*) ;;
  *) common="$ROOT/$common" ;;
esac
main_checkout="$(cd "$common/.." && pwd)"
checkout=''
for entry in "$main_checkout"/../*; do
  [ -d "$entry" ] || continue
  [ "$(printf '%s' "${entry##*/}" | tr '[:upper:]' '[:lower:]')" = 'ansiwise-cli' ] || continue
  checkout="$(cd "$entry" && pwd)"
  break
done
[ -n "$checkout" ] \
  || fail "no ansiwise-cli checkout beside $main_checkout, and the suite that binds these programs to the shipped registry lives there"
git -C "$checkout" cat-file -e "$pin^{commit}" 2>/dev/null \
  || fail "$checkout lacks ansiwise-cli at $pin, the commit ci-sources.json pins; fetch it there: git -C $checkout fetch origin"
cli="$(mktemp -d)" || fail 'no temporary directory could be made'
# The caller removes the tree once it is named; until then a failure here removes it.
trap 'rm -rf "$cli"' EXIT
git -C "$checkout" archive "$pin" | tar -x -C "$cli" \
  || fail "ansiwise-cli at $pin could not be read from $checkout"
[ -f "$cli/$SUITE" ] \
  || fail "$cli/$SUITE is missing, so these programs cannot be bound to a registry"
trap - EXIT
printf '%s\n' "$cli"
