import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The E2E runner reads the tenants' E2E passwords, <stage>/tenants/<guid>/e2e, and nothing else, and
// only its own store's account in its own namespace logs in under that role.
const READ = 'path "secret/data/+/tenants/+/e2e" { capabilities = ["read"] }\n';
const BODY = {bound_service_account_names: ['e2e-runner-eso'], bound_service_account_namespaces: ['e2e-runner'],
  token_policies: ['e2e-runner'], ttl: '24h'};

const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-platform-services.yaml', import.meta.url))], {encoding: 'utf8'}));

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

test('the e2e-runner role reads the E2E passwords alone, for its own account alone', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a wider grant, a list grant, another account or a namespace selector is found, and the program itself is not', () => {
  const policy = rows => rows.find(row => row.step === 'vault_policy' && row.name === 'e2e-runner');
  const role = rows => rows.find(row => row.step === 'vault_auth_role' && row.role === 'e2e-runner');
  const planted = {
    'every entry of a tenant': rows => { policy(rows).rules = 'path "secret/data/+/tenants/+/*" { capabilities = ["read"] }\n'; },
    'a list grant': rows => { policy(rows).rules += 'path "secret/metadata/+/tenants/+/e2e" { capabilities = ["list"] }\n'; },
    'the application tier': rows => { policy(rows).rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
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
