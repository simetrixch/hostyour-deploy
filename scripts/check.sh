#!/usr/bin/env bash
# Local YAML parsing. Registry binding tests run in the ci of the master.
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

# What the ci of the master reads of this tree before it runs it: the tools it installs and the commit of ansiwise-cli it binds to.
yq -p=json -o=yaml e '.' "$ROOT/ci-tools.json" "$ROOT/ci-sources.json" >/dev/null || fail 'ci-tools.json or ci-sources.json does not parse'
bash -n "$ROOT/scripts/cli-checkout.sh" || fail 'CLI checkout Bash syntax'
node --check "$ROOT/scripts/cli-checkout.test.mjs" || fail 'CLI checkout check syntax'
echo "check: NOT RUN locally — scripts/cli-checkout.test.mjs; runs in the ci of the master via scripts/test.sh."
node --check "$ROOT/scripts/onboard-manager.test.mjs" || fail 'Manager onboarding access check syntax'
echo 'check: NOT RUN locally — scripts/onboard-manager.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/deploy-branch-secrets.test.mjs" || fail 'deploy-branch secrets check syntax'
echo 'check: NOT RUN locally — scripts/deploy-branch-secrets.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/deploy-branch-stamp.test.mjs" || fail 'deploy-branch stamp check syntax'
echo 'check: NOT RUN locally — scripts/deploy-branch-stamp.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/no-password-persistence.test.mjs" || fail 'no password persistence check syntax'
echo 'check: NOT RUN locally — scripts/no-password-persistence.test.mjs; runs in the ci of the master via scripts/test.sh.'

node --check "$ROOT/scripts/move-machine.mjs" || fail 'machine move syntax'
node --check "$ROOT/scripts/move-machine.test.mjs" || fail 'machine move check syntax'
bash -n "$ROOT/scripts/move-machine.sh" || fail 'machine move Bash syntax'
echo 'check: NOT RUN locally — scripts/move-machine.test.mjs; runs in the ci of the master via scripts/test.sh.'

node --check "$ROOT/scripts/host-admission-floor.test.mjs" || fail 'host admission floor check syntax'
echo 'check: NOT RUN locally — scripts/host-admission-floor.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/traefik-dashboard.test.mjs" || fail 'traefik dashboard check syntax'
echo 'check: NOT RUN locally — scripts/traefik-dashboard.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/traefik-access-log.test.mjs" || fail 'traefik access log check syntax'
echo 'check: NOT RUN locally — scripts/traefik-access-log.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/traefik-cpu-request.test.mjs" || fail 'traefik cpu request check syntax'
echo 'check: NOT RUN locally — scripts/traefik-cpu-request.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/prune-unused-images.test.mjs" || fail 'prune unused images check syntax'
echo 'check: NOT RUN locally — scripts/prune-unused-images.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/manager-tenant-key-grants.test.mjs" || fail 'manager tenant key grants check syntax'
echo 'check: NOT RUN locally — scripts/manager-tenant-key-grants.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/vault-policy-reaches.mjs" || fail 'vault policy reaches syntax'
node --check "$ROOT/scripts/build-platform-leaves.test.mjs" || fail 'build-platform leaves check syntax'
echo 'check: NOT RUN locally — scripts/build-platform-leaves.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/manager-post-client-read.test.mjs" || fail 'manager post client read check syntax'
echo 'check: NOT RUN locally — scripts/manager-post-client-read.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/e2e-runner-read.test.mjs" || fail 'e2e runner read check syntax'
echo 'check: NOT RUN locally — scripts/e2e-runner-read.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/recovery-export-read.test.mjs" || fail 'recovery export read check syntax'
echo 'check: NOT RUN locally — scripts/recovery-export-read.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/idp-bootstrap-read.test.mjs" || fail 'idp bootstrap read check syntax'
echo 'check: NOT RUN locally — scripts/idp-bootstrap-read.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/kubelet-image-gc.test.mjs" || fail 'kubelet image gc check syntax'
echo 'check: NOT RUN locally — scripts/kubelet-image-gc.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/storage-box-cidrs.test.mjs" || fail 'storage box addresses check syntax'
echo 'check: NOT RUN locally — scripts/storage-box-cidrs.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/cert-manager-installs.test.mjs" || fail 'cert-manager installs check syntax'
echo 'check: NOT RUN locally — scripts/cert-manager-installs.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/cloudflare-origin-pull-ca.test.mjs" || fail 'cloudflare origin pull CA check syntax'
echo 'check: NOT RUN locally — scripts/cloudflare-origin-pull-ca.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/vault-listener-reload.test.mjs" || fail 'vault listener reload check syntax'
echo 'check: NOT RUN locally — scripts/vault-listener-reload.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/forgejo.test.mjs" || fail 'Forgejo client secret and values check syntax'
echo 'check: NOT RUN locally — scripts/forgejo.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/plane.test.mjs" || fail 'Plane secrets and values check syntax'
echo 'check: NOT RUN locally — scripts/plane.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/forgejo-webhook.test.mjs" || fail 'Forgejo webhook key check syntax'
echo 'check: NOT RUN locally — scripts/forgejo-webhook.test.mjs; runs in the ci of the master via scripts/test.sh.'

python3 -c 'import ast, pathlib, sys; [ast.parse(pathlib.Path(p).read_text()) for p in sys.argv[1:]]' "$ROOT/scripts/tenant-stage-proof.py" "$ROOT/scripts/tenant-stage-proof.test.py" || fail 'tenant stage proof Python syntax'
bash -n "$ROOT/scripts/tenant-stage-proof.sh" || fail 'tenant stage proof Bash syntax'
echo 'check: NOT RUN locally — scripts/tenant-stage-proof.test.py; public CI, except the explicit operator regression-first instruction.'

echo 'check: NOT RUN locally — dart test test/checks/config_validity_test.dart; runs in the ci of the master via scripts/test.sh.'

node --check "$ROOT/scripts/owned-storage.test.mjs" || fail 'owned storage check syntax'
echo 'check: NOT RUN locally — scripts/owned-storage.test.mjs; runs in the ci of the master via scripts/test.sh.'
node --check "$ROOT/scripts/forgejo-build-credentials.test.mjs" || fail 'Forgejo credential producer check syntax'
bash -n "$ROOT/ansiwise/templates/forgejo-build-credentials.sh.tpl" || fail 'Forgejo credential producer Bash syntax'
echo 'check: NOT RUN locally — scripts/forgejo-build-credentials.test.mjs; runs in the ci of the master via scripts/test.sh.'
python3 -I -c 'import ast, pathlib, sys; ast.parse(pathlib.Path(sys.argv[1]).read_text())' "$ROOT/ansiwise/templates/forgejo-plane-access.py.tpl" || fail 'Forgejo and Plane access module Python syntax'
node --check "$ROOT/scripts/forgejo-plane-access-fake.mjs" || fail 'Forgejo and Plane fake cluster syntax'
node --check "$ROOT/scripts/plane-sign-in.test.mjs" || fail 'Plane sign-in producer check syntax'
bash -n "$ROOT/ansiwise/templates/plane-sign-in.sh.tpl" || fail 'Plane sign-in producer Bash syntax'
echo 'check: NOT RUN locally — scripts/plane-sign-in.test.mjs; runs in the ci of the master via scripts/test.sh.'
echo 'check: OK — every local check green'
