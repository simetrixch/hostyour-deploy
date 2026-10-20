#!/usr/bin/env bash
# The pool of scripts/test.sh: its text runs here in a temporary repository, with the list of suites replaced by planted
# ones, a stand-in scripts/cli-checkout.sh and a stand-in dart. The pool must run suites at once, hand the CLI tree to the
# suites that start the CLI, print a passed suite as one line and a failed one in full, and end red for a failed suite, for
# a skipped Dart suite and for a suite that leaves no status. Each case plants the defect it must catch and has an innocent
# that must pass.
#
#   bash scripts/test-pool.test.sh
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fail() { echo "test-pool.test: RED — $*" >&2; exit 1; }
ok() { echo "test-pool.test: ok — $*"; }
work="$(mktemp -d)" || fail "no temporary directory could be made"
trap 'rm -rf "$work"' EXIT

repo="$work/repo"
cli="$work/cli"
mkdir -p "$repo/scripts" "$repo/bin" "$repo/suites" "$cli"

# A stand-in for scripts/cli-checkout.sh, which makes the CLI tree that scripts/test.sh removes at its end and names it,
# and for dart, which answers what DART_OUTPUT holds.
printf '#!/usr/bin/env bash\nmkdir -p "%s"\necho "%s"\n' "$cli" "$cli" >"$repo/scripts/cli-checkout.sh"
cat >"$repo/bin/dart" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "${DART_OUTPUT:-}"
SH
chmod +x "$repo/bin/dart"

# Builds the test copy of scripts/test.sh with the suites given as arguments, each "<kind> <file> '<note>'".
build_pool() {
  : >"$work/planted"
  for suite in "$@"; do printf 'suite %s\n' "$suite" >>"$work/planted"; done
  awk -v planted="$work/planted" '
    /^# One suite of the pool/ { while ((getline line < planted) > 0) print line }
    /^suite / { next }
    { print }
  ' "$ROOT/scripts/test.sh" >"$repo/scripts/test.sh"
}
run_pool() { # jobs -> output in $work/out, status in $work/status
  (cd "$repo" && PATH="$repo/bin:$PATH" TEST_JOBS="$1" bash scripts/test.sh >"$work/out" 2>&1; echo "$?" >"$work/status")
}

# 1. The innocent: two passing suites end green with a line each and no output of their own.
cat >"$repo/suites/one.py" <<'PY'
print('noise-of-one')
PY
cat >"$repo/suites/two.py" <<'PY'
pass
PY
build_pool "python suites/one.py 'the first'" "python suites/two.py 'the second'"
run_pool 2
[ "$(cat "$work/status")" = 0 ] || { cat "$work/out"; fail "two passing suites did not end green"; }
grep -q '^test: ok — suites/one.py ([0-9]* s) — the first$' "$work/out" || fail "a passed suite is not printed as a line with its note"
grep -q 'noise-of-one' "$work/out" && fail "the output of a passed suite is printed"
grep -q '^test: OK — every check green$' "$work/out" || fail "a green run does not say so"
ok "two passing suites end green, one line each with their time and note, and their own output stays out"

# 2. The suites run at once: each waits for the other's marker, which only a second suite running beside it can leave.
for name in left right; do
  other=right; [ "$name" = left ] || other=left
  cat >"$repo/suites/$name.test.mjs" <<JS
import {existsSync, writeFileSync} from 'node:fs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('the other suite runs beside this one', async () => {
  writeFileSync('$work/$name.up', '');
  for (let i = 0; i < 50 && !existsSync('$work/$other.up'); i++) await new Promise(done => setTimeout(done, 100));
  assert.ok(existsSync('$work/$other.up'));
});
JS
done
build_pool "node suites/left.test.mjs 'left'" "node suites/right.test.mjs 'right'"
rm -f "$work"/*.up
run_pool 2
[ "$(cat "$work/status")" = 0 ] || { cat "$work/out"; fail "two suites that wait for each other did not run at once with TEST_JOBS=2"; }
rm -f "$work"/*.up
run_pool 1
[ "$(cat "$work/status")" != 0 ] || fail "PLANTED DEFECT: suites run one after the other were not seen red"
ok "TEST_JOBS=2 runs two suites at once; the planted defect, TEST_JOBS=1, is red because neither suite sees the other"

# 3. The kinds: node-cli hands the CLI tree to the suite, node does not; dart runs in the CLI tree.
cat >"$repo/suites/cli.test.mjs" <<JS
import {test} from 'node:test';
import assert from 'node:assert/strict';
test('the CLI tree', () => assert.equal(process.env.ANSIWISE_CLI_CHECKOUT, '$cli'));
JS
build_pool "node-cli suites/cli.test.mjs 'with the tree'"
run_pool 2
[ "$(cat "$work/status")" = 0 ] || { cat "$work/out"; fail "a node-cli suite did not get the CLI tree"; }
build_pool "node suites/cli.test.mjs 'without the tree'"
run_pool 2
[ "$(cat "$work/status")" != 0 ] || fail "PLANTED DEFECT: a node suite that got the CLI tree it should not have was not seen"
ok "a node-cli suite gets ANSIWISE_CLI_CHECKOUT, a node suite does not"

# 4. A Dart suite that skips its tests is red, one that ran them is green.
build_pool "dart suites/binding_test.dart 'the binding'"
DART_OUTPUT='00:00 +3: All tests passed!' run_pool 2
[ "$(cat "$work/status")" = 0 ] || { cat "$work/out"; fail "a Dart suite that ran its tests did not end green"; }
DART_OUTPUT='00:00 +0 ~3: All tests skipped.' run_pool 2
[ "$(cat "$work/status")" != 0 ] || fail "PLANTED DEFECT: a Dart suite that skipped its tests ended green"
grep -q 'skipped its tests, so no program was bound to the shipped registry' "$work/out" || fail "a skipped Dart suite does not say so"
ok "a Dart suite that skips its tests ends the run red"

# 5. A failed suite ends red, prints its whole output after the passed ones and names itself last; the others still ran.
cat >"$repo/suites/bad.py" <<'PY'
import sys
print('first-line-of-bad')
print('last-line-of-bad', file=sys.stderr)
sys.exit(3)
PY
build_pool "python suites/bad.py 'the bad one'" "python suites/two.py 'the second'"
run_pool 2
[ "$(cat "$work/status")" != 0 ] || fail "PLANTED DEFECT: a failed suite ended green"
grep -q '^test: ok — suites/two.py (' "$work/out" || fail "the suite beside the failed one did not run"
grep -q '^first-line-of-bad$' "$work/out" && grep -q '^last-line-of-bad$' "$work/out" || fail "a failed suite is not printed in full"
grep -q '^test: FAIL — suites/bad.py exited 3 after [0-9]* s: the bad one$' "$work/out" || fail "a failed suite does not name its exit status and note"
[ "$(tail -n 1 "$work/out")" = 'test: FAIL — suites/bad.py' ] || fail "the last line does not name the failed suite"
grep -q 'every check green' "$work/out" && fail "a red run says it is green"
ok "a failed suite ends the run red, in full after the passed ones and named on the last line; the suite beside it still ran"

# 6. A suite that kills the process running it leaves no status, which is a failure and not a green.
cat >"$repo/suites/gone.py" <<'PY'
import os, signal
os.kill(os.getppid(), signal.SIGKILL)
PY
build_pool "python suites/gone.py 'the vanishing one'" "python suites/two.py 'the second'"
run_pool 2
[ "$(cat "$work/status")" != 0 ] || fail "PLANTED DEFECT: a suite that left no status ended green"
grep -q '^test: FAIL — suites/gone.py left no status: it was killed' "$work/out" || fail "a suite without a status is not named"
ok "a suite that leaves no status ends the run red"
