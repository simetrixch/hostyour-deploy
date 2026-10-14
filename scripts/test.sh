#!/usr/bin/env bash
# Bind this tree to the shipped CLI registry in the ci of the master.
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SUITE='test/checks/config_validity_test.dart'
fail() { echo "test: FAIL — $1"; exit 1; }

# STEP 2 — every program binds to the registry the shipped binary carries.
#
# THE CLI TREE IS NAMED BY scripts/cli-checkout.sh: the commit ci-sources.json pins, on the ci of the master, and the
# checkout beside the main one on a machine. What it prints is the root of that tree.
cli="$(bash "$ROOT/scripts/cli-checkout.sh" "$SUITE")" || exit 1
command -v dart >/dev/null 2>&1 \
  || fail 'dart is not on PATH, and the suite that binds these programs to the shipped registry is a Dart test'
# THE PINNED TREE IS AN ARCHIVE, and nobody has resolved its packages: a checkout beside the main one was.
if [ -n "${CI_SOURCES_DIR:-}" ]; then
  (cd "$cli" && dart pub get) || fail "dart pub get in the pinned ansiwise-cli tree $cli"
fi

# THE TREE UNDER TEST IS NAMED, and is not left to the search the suite runs when nothing names
# one. That search takes the one directory near the CLI checkout that holds ansiwise/programs, and
# it refuses where a machine carries two. Naming this checkout makes the suite read the tree this
# check is about, on every machine.

# The output is captured so a SKIPPED suite can be told from a green one, then printed whole.
# Standard error is not captured and reaches the screen while the suite runs.
output="$(cd "$cli" && ANSIWISE_INSTALLATION="$ROOT" dart test "$SUITE")"
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

node --test "$ROOT/scripts/cli-checkout.test.mjs" || fail 'the tree of ansiwise-cli the binding suite runs in'
node --test "$ROOT/scripts/move-machine.test.mjs" || fail 'machine move launcher'
node --test "$ROOT/scripts/tenant-stage-policy.test.mjs" || fail 'tenant stage Vault policy contract'
node --test "$ROOT/scripts/host-admission-floor.test.mjs" || fail 'host admission floor'
node --test "$ROOT/scripts/traefik-dashboard.test.mjs" || fail 'traefik dashboard off the web'
node --test "$ROOT/scripts/prune-unused-images.test.mjs" || fail 'prune unused images before the free-disk check'
node --test "$ROOT/scripts/manager-tenant-key-grants.test.mjs" || fail 'manager grants every tenant app key kind'
node --test "$ROOT/scripts/manager-post-client-read.test.mjs" || fail 'manager reads the post client secret from its own entry alone'
node --test "$ROOT/scripts/e2e-runner-read.test.mjs" || fail 'the e2e runner reads the E2E passwords alone'
node --test "$ROOT/scripts/idp-bootstrap-read.test.mjs" || fail 'no cluster secret reader reads idp bootstrap'
node --test "$ROOT/scripts/kubelet-image-gc.test.mjs" || fail 'kubelet collects unused images'
node --test "$ROOT/scripts/publish-mail-dkim.test.mjs" || fail 'publish-mail-dkim writes only the DKIM record'
node --test "$ROOT/scripts/cert-manager-installs.test.mjs" || fail 'cert-manager installed only where none stands, never the addon'
node --test "$ROOT/scripts/vault-listener-reload.test.mjs" || fail 'the secret store reloads its renewed TLS pair daily'

python3 "$ROOT/scripts/tenant-stage-proof.test.py" || fail 'tenant stage permission proof'

echo 'test: OK — every check green'
