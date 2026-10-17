import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {pathPattern, reaches} from './vault-policy-reaches.mjs';

// The passwords of the two Authentik test accounts of the Plane sign-in proof (digita-testkit
// cases/plane-sign-in.spec.ts). Each is minted once, in <stage>/idp/bootstrap, beside every client secret;
// the provider's pods read them as IDP_PLANE_TEST_ACCOUNT_PASSWORD and IDP_PLANE_TEST_UNINVITED_PASSWORD
// for the blueprint 20-plane-test-accounts.yaml of hostyour-cloud. The e2e-runner reads both from
// <stage>/app/plane-test-account, written FROM the minted values by one row and never minted again; no value
// stands in the program, and the E2E password policy gains no line for it.
const LEAF = '<stage>/app/plane-test-account';
const BOOTSTRAP = '<stage>/idp/bootstrap';
const ACCOUNTS = [
  {bootstrap: 'plane-test-account-password', provider: 'IDP_PLANE_TEST_ACCOUNT_PASSWORD', leaf: 'password', variable: 'PLANE_TEST_ACCOUNT_PASSWORD'},
  {bootstrap: 'plane-test-uninvited-password', provider: 'IDP_PLANE_TEST_UNINVITED_PASSWORD', leaf: 'uninvited-password', variable: 'PLANE_TEST_UNINVITED_PASSWORD'},
];

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
  for (const account of ACCOUNTS) {
    if (!bootstrap?.fields.includes(`${account.bootstrap}=${account.provider}`) || !bootstrap?.mint.includes(account.bootstrap)) found.push(`the bootstrap entry does not mint ${account.bootstrap}`);
    if (!provider?.fields.includes(`${account.provider}=${account.bootstrap}`)) found.push(`idp-bootstrap-secrets does not carry ${account.provider}`);
  }
  // The data path Vault checks for the entry, in a stage called prod; the E2E runner's policy must not reach it.
  const entry = `secret/data/${LEAF.replace('<stage>', 'prod')}`;
  for (const policy of steps.filter(step => step.step === 'vault_policy' && step.name === 'e2e-runner')) {
    if (policy.rules.split('\n').some(line => reaches(pathPattern(line), entry))) found.push('the e2e-runner policy reaches the test accounts\' entry, which the runner reads through the default secret reader');
  }
  const rows = steps.filter(step => step.step === 'vault_kv_entry' && step.path === LEAF);
  if (rows.length !== 1) return [...found, `${rows.length} rows write ${LEAF}, not 1`];
  const [row] = rows;
  const copies = ACCOUNTS.map(account => `${account.leaf}=${BOOTSTRAP}:${account.bootstrap}`);
  if (JSON.stringify(row.copy_from) !== JSON.stringify(copies)) found.push(`${LEAF} is not written from the bootstrap entry's two minted passwords`);
  if (JSON.stringify(row.fields) !== JSON.stringify(ACCOUNTS.map(account => `${account.leaf}=${account.variable}`))) found.push(`${LEAF} holds other fields than the two passwords`);
  if ((row.mint ?? []).length > 0) found.push(`${LEAF} mints, so a value there is not the one the provider holds`);
  if (!['secret_store_enabled', 'idp_enabled', 'books_here_in_answers'].every(when => (row.when ?? []).includes(when))) found.push(`${LEAF} is written where no identity provider or no books are`);
  for (const entry of [...(row.fields ?? []), ...(bootstrap?.fields ?? []).filter(field => /^plane-test-/.test(field))]) {
    if (!namesVariable(entry)) found.push(`${entry.split('=')[0]} is not read from a variable of the hand-filled input`);
  }
  for (const entry of (provider?.fields ?? []).filter(field => /PLANE_TEST/.test(field))) {
    if (!/^IDP_PLANE_TEST_[A-Z_]+=[a-z][a-z0-9-]*$/.test(entry)) found.push(`${entry.split('=')[0]} is not read from the bootstrap entry by name`);
  }
  return found;
}

test('both test passwords are minted once and copied to the e2e-runner\'s own entry by one row', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a second row, a mint in the entry, a missing bootstrap mint, a missing provider key and a literal password are found', () => {
  const leaf = steps => steps.find(s => s.path === LEAF);
  const planted = {
    'a second row erases the first': steps => { steps.push({...leaf(steps), fields: ['planted=PLANTED'], copy_from: undefined}); },
    'the entry mints its own passwords': steps => { leaf(steps).mint = ['password']; },
    'no row writes the entry': steps => { steps.splice(steps.indexOf(leaf(steps)), 1); },
    'the entry copies one password only': steps => { leaf(steps).copy_from.pop(); },
    'the bootstrap entry does not mint the invited account\'s password': steps => { const b = steps.find(s => s.path === BOOTSTRAP); b.mint = b.mint.filter(f => f !== 'plane-test-account-password'); },
    'the provider never sees the uninvited account\'s password': steps => { const p = steps.find(s => s.name === 'idp-bootstrap-secrets'); p.fields = p.fields.filter(f => !f.startsWith('IDP_PLANE_TEST_UNINVITED')); },
    'the e2e-runner policy reaches the application tier': steps => { steps.find(s => s.step === 'vault_policy' && s.name === 'e2e-runner').rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
    'a password stands in the entry as a literal': steps => { leaf(steps).fields[0] = 'password=Sup3rSecretValue'; },
    'a password stands in the bootstrap entry as a literal': steps => { const b = steps.find(s => s.path === BOOTSTRAP); b.fields = b.fields.map(f => f.startsWith('plane-test-account-password=') ? 'plane-test-account-password=hunter2hunter2' : f); },
    'the provider takes a literal': steps => { const p = steps.find(s => s.name === 'idp-bootstrap-secrets'); p.fields = p.fields.map(f => f.startsWith('IDP_PLANE_TEST_ACCOUNT_PASSWORD=') ? 'IDP_PLANE_TEST_ACCOUNT_PASSWORD=Sup3rSecret' : f); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const steps = structuredClone(program.steps);
    plant(steps);
    assert.notDeepEqual(findings(steps), [], name);
  }
});

test('PLANTED INNOCENT: the rows in another order are not found', () => {
  assert.deepEqual(findings([...program.steps].reverse()), []);
});
