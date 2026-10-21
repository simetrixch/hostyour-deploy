import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {pathPattern, reaches} from './vault-policy-reaches.mjs';

// The password of the Authentik test account `platform-sign-in` of the Argo CD and Headlamp sign-in proofs (digita-testkit
// cases/argocd-sign-in.spec.ts and cases/headlamp-sign-in.spec.ts), and the group `platform-readers` that account stands
// in. The password is minted once, in <stage>/idp/bootstrap, beside every client secret; the provider's pods read it as
// IDP_PLATFORM_TEST_ACCOUNT_PASSWORD for the blueprint 21-platform-test-accounts.yaml of hostyour-cloud. The e2e-runner
// reads it from <stage>/app/platform-test-account, written FROM the minted value by one row and never minted again; no
// value stands in the program, and the E2E password policy gains no line for it. The group is bound on the master's
// Kubernetes API to the role `view` and to nothing broader, because Headlamp shows what the API server lets the token read.
const LEAF = '<stage>/app/platform-test-account';
const BOOTSTRAP = '<stage>/idp/bootstrap';
const PASSWORD = {bootstrap: 'platform-test-account-password', provider: 'IDP_PLATFORM_TEST_ACCOUNT_PASSWORD', leaf: 'password', variable: 'PLATFORM_TEST_ACCOUNT_PASSWORD'};
const GROUP = 'platform-readers';

const PROGRAMS = fileURLToPath(new URL('../ansiwise/programs/', import.meta.url));
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', `${PROGRAMS}${file}`], {encoding: 'utf8'}));
const program = read('deploy-platform-services.yaml');

/** Whether `entry` of a `fields` list is <name>=<NAME>, a field and the variable of the hand-filled input that holds it, never a value. */
const namesVariable = entry => /^[a-z][a-z0-9-]*=[A-Z][A-Z0-9_]*$/.test(entry);

/** Every way the program breaks the rule, named. */
function findings(steps) {
  const found = [];
  const bootstrap = steps.find(step => step.step === 'vault_kv_entry' && step.path === BOOTSTRAP);
  const provider = steps.find(step => step.step === 'kubernetes_secret_from_vault' && step.name === 'idp-bootstrap-secrets');
  if (!bootstrap?.fields.includes(`${PASSWORD.bootstrap}=${PASSWORD.provider}`) || !bootstrap?.mint.includes(PASSWORD.bootstrap)) found.push(`the bootstrap entry does not mint ${PASSWORD.bootstrap}`);
  if (!provider?.fields.includes(`${PASSWORD.provider}=${PASSWORD.bootstrap}`)) found.push(`idp-bootstrap-secrets does not carry ${PASSWORD.provider}`);
  // The data path Vault checks for the entry, in a stage called prod; the E2E runner's policy must not reach it.
  const entry = `secret/data/${LEAF.replace('<stage>', 'prod')}`;
  for (const policy of steps.filter(step => step.step === 'vault_policy' && step.name === 'e2e-runner')) {
    if (policy.rules.split('\n').some(line => reaches(pathPattern(line), entry))) found.push('the e2e-runner policy reaches the test account\'s entry, which the runner reads through the default secret reader');
  }
  const rows = steps.filter(step => step.step === 'vault_kv_entry' && step.path === LEAF);
  if (rows.length !== 1) found.push(`${rows.length} rows write ${LEAF}, not 1`);
  else {
    const [row] = rows;
    if (JSON.stringify(row.copy_from) !== JSON.stringify([`${PASSWORD.leaf}=${BOOTSTRAP}:${PASSWORD.bootstrap}`])) found.push(`${LEAF} is not written from the bootstrap entry's minted password`);
    if (JSON.stringify(row.fields) !== JSON.stringify([`${PASSWORD.leaf}=${PASSWORD.variable}`])) found.push(`${LEAF} holds other fields than the password`);
    if ((row.mint ?? []).length > 0) found.push(`${LEAF} mints, so a value there is not the one the provider holds`);
    if (!['secret_store_enabled', 'idp_enabled', 'books_here_in_answers'].every(when => (row.when ?? []).includes(when))) found.push(`${LEAF} is written where no identity provider or no books are`);
    if (!namesVariable(row.fields?.[0] ?? '')) found.push(`${row.fields?.[0]?.split('=')[0]} is not read from a variable of the hand-filled input`);
  }
  for (const field of (bootstrap?.fields ?? []).filter(field => /^platform-test-/.test(field))) {
    if (!namesVariable(field)) found.push(`${field.split('=')[0]} is not read from a variable of the hand-filled input`);
  }
  for (const field of (provider?.fields ?? []).filter(field => /PLATFORM_TEST/.test(field))) {
    if (!/^IDP_PLATFORM_TEST_[A-Z_]+=[a-z][a-z0-9-]*$/.test(field)) found.push(`${field.split('=')[0]} is not read from the bootstrap entry by name`);
  }
  const bindings = steps.filter(step => step.step === 'oidc_admins_binding' && step.group === GROUP);
  if (bindings.length !== 1) found.push(`${bindings.length} rows bind ${GROUP} on the cluster, not 1`);
  for (const binding of bindings) {
    if (binding.name !== 'oidc-platform-readers') found.push(`${binding.name} is not the binding of ${GROUP}, oidc-platform-readers`);
    if (binding.cluster_role !== 'view') found.push(`${binding.name} gives ${GROUP} ${binding.cluster_role}, and view is the widest it may have`);
    if (binding.groups_prefix !== undefined) found.push(`${binding.name} names a groups prefix of its own, which the program sets once for the API server and every binding`);
    if (!['idp_enabled', 'books_here_in_answers'].every(when => (binding.when ?? []).includes(when))) found.push(`${binding.name} is written where no identity provider or no books are`);
  }
  return found;
}

test('the platform test password is minted once and copied to the e2e-runner\'s own entry by one row, and its group is bound to view alone', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a second row, a mint in the entry, a missing bootstrap mint, a missing provider key, a literal password and a wider binding are found', () => {
  const leaf = steps => steps.find(s => s.path === LEAF);
  const binding = steps => steps.find(s => s.step === 'oidc_admins_binding' && s.group === GROUP);
  const planted = {
    'a second row erases the first': steps => { steps.push({...leaf(steps), fields: ['planted=PLANTED'], copy_from: undefined}); },
    'the entry mints its own password': steps => { leaf(steps).mint = ['password']; },
    'no row writes the entry': steps => { steps.splice(steps.indexOf(leaf(steps)), 1); },
    'the entry copies nothing': steps => { delete leaf(steps).copy_from; },
    'the entry is written where no books are': steps => { leaf(steps).when = ['secret_store_enabled']; },
    'the bootstrap entry does not mint the password': steps => { const b = steps.find(s => s.path === BOOTSTRAP); b.mint = b.mint.filter(f => f !== PASSWORD.bootstrap); },
    'the provider never sees the password': steps => { const p = steps.find(s => s.name === 'idp-bootstrap-secrets'); p.fields = p.fields.filter(f => !f.startsWith(PASSWORD.provider)); },
    'the e2e-runner policy reaches the application tier': steps => { steps.find(s => s.step === 'vault_policy' && s.name === 'e2e-runner').rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
    'a password stands in the entry as a literal': steps => { leaf(steps).fields[0] = 'password=Sup3rSecretValue'; },
    'a password stands in the bootstrap entry as a literal': steps => { const b = steps.find(s => s.path === BOOTSTRAP); b.fields = b.fields.map(f => f.startsWith(`${PASSWORD.bootstrap}=`) ? `${PASSWORD.bootstrap}=hunter2hunter2` : f); },
    'the provider takes a literal': steps => { const p = steps.find(s => s.name === 'idp-bootstrap-secrets'); p.fields = p.fields.map(f => f.startsWith(`${PASSWORD.provider}=`) ? `${PASSWORD.provider}=Sup3rSecret` : f); },
    'no row binds the group': steps => { steps.splice(steps.indexOf(binding(steps)), 1); },
    'the group is bound to cluster-admin': steps => { binding(steps).cluster_role = 'cluster-admin'; },
    'the group is bound to edit': steps => { binding(steps).cluster_role = 'edit'; },
    'a second row binds the group to cluster-admin': steps => { steps.push({...binding(steps), name: 'oidc-platform-readers-admin', cluster_role: 'cluster-admin'}); },
    'the binding carries a prefix of its own': steps => { binding(steps).groups_prefix = 'oidc:'; },
    'the binding is not named for the readers': steps => { binding(steps).name = 'oidc-platform-admins'; },
    'the binding is written where no books are': steps => { binding(steps).when = ['idp_enabled']; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const steps = structuredClone(program.steps);
    plant(steps);
    assert.notDeepEqual(findings(steps), [], name);
  }
});

test('PLANTED INNOCENT: the rows in another order, and one more binding of another group to cluster-admin, are not found', () => {
  assert.deepEqual(findings([...program.steps].reverse()), []);
  assert.deepEqual(findings([...program.steps, {step: 'oidc_admins_binding', name: 'oidc-platform-staff', group: 'admins', cluster_role: 'cluster-admin'}]), []);
});
