import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {pathPattern, reaches} from './vault-policy-reaches.mjs';

// The recovery export of the build plane reads the installation's one storage box login,
// <stage>/app/storage-box, and nothing else, and only its own store's account in the three build
// namespaces that write the recovery folder logs in under that role. The login opens every backup of
// the installation, and every other build namespace, the units of external parties among them, must
// not reach it.
const POLICY = '<cluster>-recovery-export-read';
const ROLE = 'build-recovery-export';
const READ = 'path "secret/data/<stage>/app/storage-box" { capabilities = ["read"] }';
const WRITERS = ['hostyour-cloud-build', 'hostyour-manager-build', 'ansiwise-cli-build'];
const BODY = {bound_service_account_names: ['recovery-export-eso'], bound_service_account_namespaces: WRITERS,
  token_policies: [POLICY], ttl: '24h'};
const WHEN = ['secret_store_enabled', 'build_plane_here_in_answers', 'books_here_in_answers'];
const ENTRY = ['secret/data/<stage>/app/storage-box', 'secret/metadata/<stage>/app/storage-box'];

const PROGRAMS = fileURLToPath(new URL('../ansiwise/programs/', import.meta.url));
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', `${PROGRAMS}${file}`], {encoding: 'utf8'}));
const program = read('deploy-platform-services.yaml');
const programs = readdirSync(PROGRAMS).filter(file => file.endsWith('.yaml')).map(file => ({file, steps: read(file).steps ?? []}));
const lines = rules => (rules ?? '').split('\n').map(line => line.trim()).filter(Boolean);

/** Every way the program departs from the recovery export's own reader, named. */
function findings(steps) {
  const found = [];
  const policies = steps.filter(row => row.step === 'vault_policy' && row.name === POLICY);
  if (policies.length !== 1) found.push(`${policies.length} ${POLICY} policies, not 1`);
  else if (policies[0].rules !== `${READ}\n`) found.push(`the ${POLICY} policy grants more or other than ${READ}`);
  const roles = steps.filter(row => row.step === 'vault_auth_role' && row.role === ROLE);
  if (roles.length !== 1) found.push(`${roles.length} ${ROLE} roles, not 1`);
  else if (JSON.stringify(JSON.parse(roles[0].body)) !== JSON.stringify(BODY)) found.push(`the ${ROLE} role binds another account, namespace or policy`);
  for (const row of [...policies, ...roles]) {
    if (JSON.stringify(row.when) !== JSON.stringify(WHEN)) found.push(`${row.step} ${row.name ?? row.role} is not installed exactly where the build plane and the books are kept`);
  }
  for (const row of steps.filter(row => row.step === 'vault_auth_role' && row.role !== ROLE)) {
    if ((JSON.parse(row.body).token_policies ?? []).includes(POLICY)) found.push(`the role ${row.role} also carries ${POLICY}`);
  }
  return found;
}

/** Whether a role's binding admits a build namespace: by the build label, by a name of one, by a glob or by an empty selector. */
function admitsBuildNamespace(body) {
  const role = JSON.parse(body);
  if ((role.bound_service_account_namespaces ?? []).some(name => name.includes('*') || name.endsWith('-build'))) return true;
  const selector = role.bound_service_account_namespace_selector;
  if (!selector) return false;
  const labels = JSON.parse(selector).matchLabels ?? {};
  return Object.keys(labels).length === 0 || labels['hostyour.cloud/build'] === 'true';
}

/** Every policy line, handed to a role a build namespace logs in under, that reaches the login, other than the recovery export's own read. */
function reachFindings(steps) {
  const found = [];
  for (const role of steps.filter(row => row.step === 'vault_auth_role' && admitsBuildNamespace(row.body))) {
    for (const name of JSON.parse(role.body).token_policies ?? []) {
      for (const policy of steps.filter(row => row.step === 'vault_policy' && row.name === name)) {
        for (const line of lines(policy.rules)) {
          const hits = ENTRY.filter(path => reaches(pathPattern(line), path));
          if (hits.length > 0 && !(role.role === ROLE && name === POLICY && line === READ)) found.push(`the role ${role.role} reaches ${hits.join(', ')} through ${name} with ${line}`);
        }
      }
    }
  }
  return found;
}

const policy = (rows, name) => rows.find(row => row.step === 'vault_policy' && row.name === name);
const role = (rows, name) => rows.find(row => row.step === 'vault_auth_role' && row.role === name);

test('the build-recovery-export role reads the storage box login alone, for its own account in the three writer namespaces alone', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a wider grant, another account, the build label, a second role or another place is found, and the program itself is not', () => {
  const planted = {
    'the policy widened to the application tier': rows => { policy(rows, POLICY).rules = 'path "secret/data/<stage>/app/*" { capabilities = ["read"] }\n'; },
    'a list grant': rows => { policy(rows, POLICY).rules += 'path "secret/metadata/<stage>/app/storage-box" { capabilities = ["list"] }\n'; },
    'the role bound to external-secrets-sa': rows => { role(rows, ROLE).body = role(rows, ROLE).body.replace('"recovery-export-eso"', '"external-secrets-sa"'); },
    'the role bound by the build label': rows => { role(rows, ROLE).body = JSON.stringify({...BODY, bound_service_account_namespaces: [], bound_service_account_namespace_selector: '{"matchLabels":{"hostyour.cloud/build":"true"}}'}); },
    'a fourth namespace': rows => { role(rows, ROLE).body = JSON.stringify({...BODY, bound_service_account_namespaces: [...WRITERS, 'swissbookai-build']}); },
    'a second role on the policy': rows => { rows.push({...role(rows, 'build-eso'), role: 'build-eso-copy', body: JSON.stringify({...JSON.parse(role(rows, 'build-eso').body), token_policies: ['<cluster>-build-read', POLICY]})}); },
    'on every cluster': rows => { policy(rows, POLICY).when = ['secret_store_enabled']; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});

test('no role a build namespace logs in under reaches the storage box login but the recovery export\'s own read', () => {
  assert.deepEqual(programs.flatMap(({file, steps}) => reachFindings(steps).map(finding => `${file}: ${finding}`)), []);
});

test('PLANTED DEFECT: a grant on the login under a role of a build namespace is found, and the workload tier and the registry read are not', () => {
  const planted = {
    'the leaf added to <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += `${READ}\n`; },
    'every stage\'s application tier in <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
    'the bump reads the login': rows => { policy(rows, '<cluster>-bump-read').rules += `${READ}\n`; },
    'a delete of the login\'s metadata in <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += 'path "secret/metadata/<stage>/app/storage-box" { capabilities = ["delete"] }\n'; },
    'the workload role admits a writer namespace by name': rows => { for (const row of rows.filter(r => r.step === 'vault_auth_role' && r.role === 'external-secrets')) row.body = JSON.stringify({...JSON.parse(row.body), bound_service_account_namespaces: ['hostyour-cloud-build']}); },
    'the workload role admits every namespace': rows => { for (const row of rows.filter(r => r.step === 'vault_auth_role' && r.role === 'external-secrets')) row.body = JSON.stringify({...JSON.parse(row.body), bound_service_account_namespace_selector: '{}'}); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(reachFindings(rows), [], name);
  }
  // The workload tier reaches the login by design, for the Manager's backups, and no build namespace logs in under it.
  const workload = policy(program.steps, '<cluster>-eso');
  assert.ok(lines(workload.rules).some(line => ENTRY.some(path => reaches(pathPattern(line), path))), 'the check sees a policy that reaches the login');
  assert.ok(lines(policy(program.steps, '<cluster>-build-read').rules).includes('path "secret/data/<stage>/app/registry" { capabilities = ["read"] }'), 'the build reader keeps its registry read');
  for (const {file, steps} of programs) assert.deepEqual(reachFindings(structuredClone(steps)), [], `the planted innocent: ${file} as it is`);
});
