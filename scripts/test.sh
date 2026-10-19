#!/usr/bin/env bash
# Bind this tree to the shipped CLI registry in the ci of the master.
#
# The suites share nothing but the ansiwise-cli tree, which they only read, so TEST_JOBS of them run at once (4 unless set). The output of a suite is kept
# in a log of its own and printed in the order of the list below once all have ended: a passed suite as one line with its time, a failed one in full,
# so the end of the output names what failed. A suite that leaves no status (killed by the kernel, for one, which also stops the pool) is a failed suite.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE='test/checks/config_validity_test.dart'
fail() { echo "test: FAIL — $1"; exit 1; }

suite_kinds=()
suite_files=()
suite_notes=()
# suite <kind> <file> <what it holds>: `dart` is the registry binding suite, run in the ansiwise-cli tree on this tree and failed where it skips;
# `node`, `python` and `bash` run a file of this tree; `node-cli` runs a node file that starts the shipped CLI from the ansiwise-cli tree
# (ANSIWISE_CLI_CHECKOUT). The pool starts the suites in this order, the slowest first (by the times a run printed on 2026-10-19),
# so the run ends when the slowest suite ends and not after the slowest has waited for a free place.
suite() {
  suite_kinds+=("$1")
  suite_files+=("$2")
  suite_notes+=("$3")
}
suite node-cli scripts/plane-sign-in.test.mjs 'Plane signs in through Forgejo with the client of its own entry'
suite node-cli scripts/repository-credentials.test.mjs 'required installation repository credentials'
suite node scripts/forgejo-build-credentials.test.mjs 'Forgejo credential producer and complete entry'
suite node-cli scripts/onboard-manager.test.mjs 'private Manager repository access before onboarding'
suite node scripts/traefik-access-log.test.mjs 'the ingress access log keeps metadata only and trusts no forwarded header'
suite node-cli scripts/deploy-branch-secrets.test.mjs 'no unused Manager PAT in generated secrets'
suite node scripts/forgejo-machine-user.test.mjs 'Forgejo machine users and their reach'
suite dart "$SUITE" 'every program binds to the registry the shipped binary carries'
suite node scripts/deploy-branch-stamp.test.mjs 'the stamp reaches only what the install branch commit carries'
suite node scripts/no-password-persistence.test.mjs 'no elevation password persistence in the platform program'
suite node scripts/cli-checkout.test.mjs 'the tree of ansiwise-cli the binding suite runs in'
suite node scripts/move-machine.test.mjs 'machine move launcher'
suite node scripts/tenant-stage-policy.test.mjs 'tenant stage Vault policy contract'
suite node scripts/host-admission-floor.test.mjs 'host admission floor'
suite node scripts/traefik-dashboard.test.mjs 'traefik dashboard off the web'
suite node scripts/observability-query-slot.test.mjs 'the cluster map names the query route of the observability plane'
suite node scripts/traefik-cpu-request.test.mjs 'the ingress controller requests the CPU the build budget counts'
suite node scripts/prune-unused-images.test.mjs 'prune unused images before the free-disk check'
suite node scripts/manager-tenant-key-grants.test.mjs 'manager grants every tenant app key kind'
suite node scripts/build-platform-leaves.test.mjs 'the platform bump credentials stand on build-platform/ alone'
suite node scripts/manager-post-client-read.test.mjs 'manager reads the post client secret from its own entry alone'
suite node scripts/e2e-runner-read.test.mjs 'the e2e runner reads the E2E passwords alone'
suite node scripts/idp-bootstrap-read.test.mjs 'no cluster secret reader reads idp bootstrap'
suite node scripts/kubelet-image-gc.test.mjs 'kubelet collects unused images and bounds container logs'
suite node scripts/publish-mail-dkim.test.mjs 'publish-mail-dkim writes only the DKIM record'
suite node scripts/cert-manager-installs.test.mjs 'cert-manager installed only where none stands, never the addon'
suite node scripts/cloudflare-origin-pull-ca.test.mjs 'the origin pull CA reaches the Vault entry every cluster reads, optional, without the client half'
suite node scripts/cloudflare-zone-settings-token.test.mjs 'the Manager settings token reaches the Vault entry of its own, optional, and no other program'
suite node scripts/vault-listener-reload.test.mjs 'the secret store reloads its renewed TLS pair daily'
suite node scripts/forgejo.test.mjs 'Forgejo gets its client secret from the one minted value and its installation values'
suite node scripts/plane.test.mjs 'Plane gets every secret from one minted entry and its installation values'
suite node scripts/plane-test-account.test.mjs 'the Plane sign-in test accounts get their passwords from one minted entry the e2e runner reads alone'
suite node scripts/owned-storage.test.mjs 'the installer downloads its tools and bootstrap charts from the owner mirror alone'
suite node scripts/forgejo-webhook.test.mjs 'the Forgejo webhook key stands in an entry of its own'
suite node scripts/register-slave-known-host.test.mjs 'register-slave puts the slave host key into the master known hosts and nothing turns host key checking off'
suite python scripts/tenant-stage-proof.test.py 'tenant stage permission proof'
suite bash scripts/test-pool.test.sh 'the pool of this script runs suites at once, hands the CLI tree to the suites that start the CLI, and ends red for a failed suite, a skipped Dart suite and one that left no status'

# One suite of the pool: `bash scripts/test.sh --suite <index>` runs it and leaves its output and "<exit status> <seconds>" in $TEST_LOGS.
if [ "${1:-}" = --suite ]; then
  index="$2"
  file="${suite_files[$index]}"
  log="$TEST_LOGS/$index"
  started="$SECONDS"
  status=0
  case "${suite_kinds[$index]}" in
    dart)
      # The output is captured so a SKIPPED suite can be told from a green one, then printed whole.
      # THE TREE UNDER TEST IS NAMED, and is not left to the search the suite runs when nothing names
      # one. That search takes the one directory near the CLI checkout that holds ansiwise/programs, and
      # it refuses where a machine carries two. Naming this checkout makes the suite read the tree this
      # check is about, on every machine.
      output="$(cd "$TEST_CLI" && ANSIWISE_INSTALLATION="$ROOT" dart test "$file" 2>"$log.err")" || status=$?
      { printf '%s\n' "$output"; cat "$log.err"; } >"$log.out"
      # A SKIPPED SUITE IS NOT A GREEN ONE. Where no installation tree is found, the suite skips itself
      # and dart test still exits 0. That is honest of the suite, because a clone standing alone has no
      # programs to judge. Here the suite was pointed at this tree, so a skip means these programs were
      # never bound to anything.
      case "$output" in
        *'All tests skipped'* | *'Skip:'*)
          echo "dart test $file skipped its tests, so no program was bound to the shipped registry" >>"$log.out"
          status=1 ;;
      esac ;;
    node) node --test "$ROOT/$file" >"$log.out" 2>&1 || status=$? ;;
    node-cli) ANSIWISE_CLI_CHECKOUT="$TEST_CLI" node --test "$ROOT/$file" >"$log.out" 2>&1 || status=$? ;;
    python) python3 "$ROOT/$file" >"$log.out" 2>&1 || status=$? ;;
    bash) bash "$ROOT/$file" >"$log.out" 2>&1 || status=$? ;;
  esac
  echo "$status $((SECONDS - started))" >"$log.status"
  exit 0
fi

# THE CLI TREE IS NAMED BY scripts/cli-checkout.sh: the commit ci-sources.json pins, on the ci of the master, and the
# checkout beside the main one on a machine. What it prints is the root of that tree.
TEST_CLI="$(bash "$ROOT/scripts/cli-checkout.sh" "$SUITE")" || exit 1
export ROOT TEST_CLI
command -v dart >/dev/null 2>&1 \
  || fail 'dart is not on PATH, and the suite that binds these programs to the shipped registry is a Dart test'
# THE PINNED TREE IS AN ARCHIVE, and nobody has resolved its packages: a checkout beside the main one was.
if [ -n "${CI_SOURCES_DIR:-}" ]; then
  (cd "$TEST_CLI" && dart pub get) || fail "dart pub get in the pinned ansiwise-cli tree $TEST_CLI"
fi

TEST_LOGS="$(mktemp -d)"
export TEST_LOGS
trap 'rm -rf "$TEST_LOGS"' EXIT
# xargs ends with 125 and starts no further suite when one of them was killed; the suites without a status are named below.
seq 0 $((${#suite_files[@]} - 1)) | xargs -n1 -P "${TEST_JOBS:-4}" bash "$ROOT/scripts/test.sh" --suite || echo "test: the pool of suites ended with status $?, so a suite was killed"

failed=()
for index in "${!suite_files[@]}"; do
  file="${suite_files[$index]}"
  log="$TEST_LOGS/$index"
  if [ ! -f "$log.status" ]; then
    failed+=("$index")
  else
    read -r status seconds <"$log.status"
    if [ "$status" = 0 ]; then
      echo "test: ok — $file (${seconds} s) — ${suite_notes[$index]}"
    else
      failed+=("$index")
    fi
  fi
done
names=()
for index in ${failed[@]+"${failed[@]}"}; do
  file="${suite_files[$index]}"
  log="$TEST_LOGS/$index"
  names+=("$file")
  echo "test: ── $file ──"
  if [ -f "$log.status" ]; then
    cat "$log.out"
    read -r status seconds <"$log.status"
    echo "test: FAIL — $file exited $status after ${seconds} s: ${suite_notes[$index]}"
  else
    echo "test: FAIL — $file left no status: it was killed, or the pool stopped before it started"
  fi
done
[ "${#failed[@]}" -eq 0 ] || fail "${names[*]}"

echo 'test: OK — every check green'
