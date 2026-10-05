import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The Manager writes one key per tenant app and kind, create-only, and purges them with the tenant
// (hostyour-manager TENANT_APP_KEY_KINDS). Each shape of its policy grants every kind the same way,
// so a kind the Manager writes is never refused by the Vault it writes to.
const KINDS = ['password-field-key', 'revalidate-secret', 'form-signing-key', 'service-key'];
const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-platform-services.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every kind a manager policy does not grant as the Manager writes and purges it. */
function findings(steps) {
  const shapes = steps.filter(row => row.step === 'vault_policy' && row.name === 'manager');
  if (shapes.length !== 2) return [`${shapes.length} shapes of the manager policy, not 2`];
  const found = [];
  for (const [i, shape] of shapes.entries()) {
    for (const kind of KINDS) {
      if (!shape.rules.includes(`path "secret/data/+/tenants/+/${kind}/+" { capabilities = ["create", "update"] }`)) found.push(`shape ${i + 1} writes no ${kind}`);
      if (!shape.rules.includes(`path "secret/metadata/+/tenants/+/${kind}/*" { capabilities = ["delete", "list"] }`)) found.push(`shape ${i + 1} purges no ${kind}`);
    }
    if (/tenants\/\+\/[a-z-]+\/\+" \{ capabilities = \[[^\]]*"read"/.test(shape.rules)) found.push(`shape ${i + 1} reads a tenant app key`);
  }
  return found;
}

test('both shapes of the manager policy write and purge every tenant app key kind, and read none', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a kind missing from one shape, or a read grant, is found, and the program itself is not', () => {
  const managerShapes = rows => rows.filter(row => row.step === 'vault_policy' && row.name === 'manager');
  const planted = {
    'no service-key write in shape 2': rows => { const s = managerShapes(rows)[1]; s.rules = s.rules.replace('path "secret/data/+/tenants/+/service-key/+" { capabilities = ["create", "update"] }', ''); },
    'no service-key purge in shape 1': rows => { const s = managerShapes(rows)[0]; s.rules = s.rules.replace('path "secret/metadata/+/tenants/+/service-key/*" { capabilities = ["delete", "list"] }', ''); },
    'a read grant on a key': rows => { const s = managerShapes(rows)[0]; s.rules = s.rules.replace('service-key/+" { capabilities = ["create", "update"]', 'service-key/+" { capabilities = ["create", "read", "update"]'); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});
