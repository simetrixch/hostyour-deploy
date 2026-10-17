import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {reaches} from './vault-policy-reaches.mjs';

// The E2E runner reads the tenants' E2E passwords, <stage>/tenants/<guid>/e2e, and the test mailbox key,
// secret/data/e2e/test-mailbox, and nothing else, and only its own store's account in its own namespace
// logs in under that role.
const MAILBOX = 'path "secret/data/e2e/test-mailbox" { capabilities = ["read"] }';
const READ = `path "secret/data/+/tenants/+/e2e" { capabilities = ["read"] }\n${MAILBOX}\n`;
const BODY = {bound_service_account_names: ['e2e-runner-eso'], bound_service_account_namespaces: ['e2e-runner'],
  token_policies: ['e2e-runner'], ttl: '24h'};
// The key opens a mailbox that also holds the owner's own mail, so the runner's read is the only grant on it.
const KEY = ['secret/data/e2e/test-mailbox', 'secret/metadata/e2e/test-mailbox'];

const PROGRAMS = fileURLToPath(new URL('../ansiwise/programs/', import.meta.url));
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', `${PROGRAMS}${file}`], {encoding: 'utf8'}));
const program = read('deploy-platform-services.yaml');
const programs = readdirSync(PROGRAMS).filter(file => file.endsWith('.yaml')).map(file => ({file, steps: read(file).steps ?? []}));

/** Every way the program breaks the rule, named. */
function findings(steps) {
  const found = [];
  const policies = steps.filter(row => row.step === 'vault_policy' && row.name === 'e2e-runner');
  if (policies.length !== 1) found.push(`${policies.length} e2e-runner policies, not 1`);
  else if (policies[0].rules !== READ) found.push(`the e2e-runner policy grants more or other than ${READ.trim()}`);
  const roles = steps.filter(row => row.step === 'vault_auth_role' && row.role === 'e2e-runner');
  if (roles.length !== 1) found.push(`${roles.length} e2e-runner roles, not 1`);
  else if (JSON.stringify(JSON.parse(roles[0].body)) !== JSON.stringify(BODY)) found.push('the e2e-runner role binds another account, namespace or policy');
  for (const row of [...policies, ...roles]) {
    if (JSON.stringify(row.when) !== JSON.stringify(['secret_store_enabled', 'books_here_in_answers'])) found.push(`${row.step} e2e-runner is not installed exactly where the books are kept`);
  }
  return found;
}

/** Every policy line among `steps` that reaches the test mailbox key, other than the runner's own read, named. */
function mailboxFindings(steps) {
  const found = [];
  // The administrators' policy reaches every path by design and is handed to no workload.
  for (const row of steps.filter(step => step.step === 'vault_policy' && step.name !== 'admin')) {
    for (const line of (row.rules ?? '').split('\n').map(l => l.trim()).filter(Boolean)) {
      const pattern = /^path "([^"]+)"/.exec(line)?.[1] ?? '';
      const hits = KEY.filter(path => reaches(pattern, path));
      if (hits.length > 0 && !(row.name === 'e2e-runner' && line === MAILBOX)) found.push(`${row.name} reaches ${hits.join(', ')} with ${line}`);
    }
  }
  return found;
}

test('the e2e-runner role reads the E2E passwords and the test mailbox key alone, for its own account alone', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a wider grant, a list or update grant, another account or a namespace selector is found, and the program itself is not', () => {
  const policy = rows => rows.find(row => row.step === 'vault_policy' && row.name === 'e2e-runner');
  const role = rows => rows.find(row => row.step === 'vault_auth_role' && row.role === 'e2e-runner');
  const planted = {
    'every entry of a tenant': rows => { policy(rows).rules = 'path "secret/data/+/tenants/+/*" { capabilities = ["read"] }\n'; },
    'a list grant': rows => { policy(rows).rules += 'path "secret/metadata/+/tenants/+/e2e" { capabilities = ["list"] }\n'; },
    'the application tier': rows => { policy(rows).rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
    'a list grant on the test mailbox key': rows => { policy(rows).rules += 'path "secret/metadata/e2e/test-mailbox" { capabilities = ["list"] }\n'; },
    'every entry under e2e/ in place of the test mailbox key': rows => { policy(rows).rules = policy(rows).rules.replace(MAILBOX, 'path "secret/data/e2e/*" { capabilities = ["read"] }'); },
    'an update grant on the test mailbox key': rows => { policy(rows).rules = policy(rows).rules.replace(MAILBOX, 'path "secret/data/e2e/test-mailbox" { capabilities = ["read", "update"] }'); },
    'another account': rows => { role(rows).body = role(rows).body.replace('"e2e-runner-eso"', '"e2e-runner-eso","pipeline-sa"'); },
    'a namespace selector': rows => { role(rows).body = role(rows).body.replace('"bound_service_account_namespaces":["e2e-runner"]', '"bound_service_account_namespace_selector":"{}"'); },
    'on every cluster': rows => { policy(rows).when = ['secret_store_enabled']; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});

test('no policy of any program reaches the test mailbox key but the e2e-runner role\'s own read', () => {
  // Both write policies into the master's Vault, which holds the key.
  for (const file of ['register-slave.yaml', 'refresh-tenant-stage-access.yaml']) assert.ok(programs.some(p => p.file === file), `${file} is among those read`);
  assert.deepEqual(programs.flatMap(({file, steps}) => mailboxFindings(steps).map(finding => `${file}: ${finding}`)), []);
});

test('PLANTED DEFECT: a grant on the test mailbox key in another policy is found, and the runner\'s own read is not', () => {
  const planted = {
    'the application tier reads the key': ['deploy-platform-services.yaml', '<cluster>-eso', MAILBOX],
    'a slave\'s reader reads every entry under e2e/': ['register-slave.yaml', '<slave_cluster_name>-eso', 'path "secret/data/e2e/*" { capabilities = ["read"] }'],
    'a templated read of the key': ['deploy-platform-services.yaml', '<cluster>-eso', 'path "secret/data/{{identity.entity.aliases.<accessor>.metadata.service_account_namespace}}/test-mailbox" { capabilities = ["read"] }'],
    'the manager deletes the key': ['deploy-platform-services.yaml', 'manager', 'path "secret/metadata/e2e/test-mailbox" { capabilities = ["delete"] }'],
  };
  for (const [name, [file, policy, line]] of Object.entries(planted)) {
    const rows = structuredClone(programs.find(p => p.file === file).steps);
    rows.find(row => row.step === 'vault_policy' && row.name === policy).rules += `\n${line}\n`;
    assert.ok(mailboxFindings(rows).some(finding => finding.startsWith(`${policy} reaches`)), name);
  }
  assert.deepEqual(mailboxFindings([{step: 'vault_policy', name: 'e2e-runner', rules: READ}]), [], 'the planted innocent: the e2e-runner policy with its own rows');
  for (const {file, steps} of programs) assert.deepEqual(mailboxFindings(structuredClone(steps)), [], `the planted innocent: ${file} as it is`);
});
