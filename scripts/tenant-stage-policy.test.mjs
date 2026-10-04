import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const stages = ['dev', 'test', 'prod'];
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', fileURLToPath(new URL('../' + file, import.meta.url))], {encoding: 'utf8'}));
const conditions = read('ansiwise.yaml').conditions;
const programs = ['register-slave', 'deploy-platform-services', 'refresh-tenant-stage-access'].map(name => read(`ansiwise/programs/${name}.yaml`));
const removal = read('ansiwise/programs/remove-slave.yaml');
const active = (row, machine) => (row.when ?? []).every(name => !name.startsWith('stage_is_not_') || name !== `stage_is_not_${machine}`);
const replace = (text, machine) => text.replaceAll('<stage>', machine);
const stageRole = (body, stage) => {
  assert.deepEqual(body.bound_service_account_names, ['external-secrets-sa']);
  assert.deepEqual(body.bound_service_account_namespaces, []);
  assert.deepEqual(JSON.parse(body.bound_service_account_namespace_selector), {matchLabels: {'platform/tenant-managed': 'true', 'platform/tenant-stage': stage}});
  assert.equal(body.ttl, '24h');
};
const rules = (stage, machine) => {
  const alias = '{{identity.entity.aliases.<accessor>.metadata.tenant}}';
  return [
    `path "secret/data/${stage}/tenants/${alias}" { capabilities = ["read"] }`,
    `path "secret/metadata/${stage}/tenants/${alias}" { capabilities = ["read", "list"] }`,
    `path "secret/data/${stage}/tenants/${alias}/*" { capabilities = ["read"] }`,
    `path "secret/metadata/${stage}/tenants/${alias}/*" { capabilities = ["read", "list"] }`,
    `path "secret/data/${machine}/app/registry" { capabilities = ["read"] }`,
  ].join('\n');
};

test('additional-stage conditions use the registered fail-closed YAML predicate', () => {
  for (const stage of stages) assert.deepEqual(conditions[`stage_is_not_${stage}`], {
    predicate: 'yaml_key_lacks_value', file: '/srv/hostyour-cloud/clusters/platform/values-<stage>.yaml', run_answer: 'stage', key: 'global.env', value: stage,
  });
  assert.equal(conditions.stage_is_prod, undefined);
});

test('master and slave programs have three exact stage roles on every machine stage', () => {
  for (const program of programs) for (const machine of stages) {
    const enabled = program.steps.filter(row => active(row, machine));
    const roles = enabled.filter(row => row.step === 'vault_auth_role' && row.role.startsWith('tenant-eso-'));
    const policies = enabled.filter(row => row.step === 'vault_policy' && row.name.includes('-tenant-read'));
    assert.equal(roles.length, 3); assert.equal(policies.length, 3);
    for (const stage of stages) {
      const selected = roles.filter(row => replace(row.role, machine) === `tenant-eso-${stage}`);
      assert.equal(selected.length, 1);
      const row = selected[0], body = JSON.parse(replace(row.body, machine));
      stageRole(body, stage);
      assert.equal(body.token_policies.length, 1);
      const policy = policies.find(value => value.name === body.token_policies[0]);
      assert.ok(policy);
      assert.equal(replace(policy.rules, machine).trim(), rules(stage, machine));
      assert.equal(policy.auth_mount, row.mount);
      if (stage === machine) assert.ok(policy.name.endsWith('-tenant-read'), 'retain the installed machine-stage policy name');
      for (const namespaceStage of stages) {
        const labels = {'platform/tenant-managed': 'true', 'platform/tenant-stage': namespaceStage};
        const selector = JSON.parse(body.bound_service_account_namespace_selector).matchLabels;
        const admitted = Object.entries(selector).every(([key, value]) => labels[key] === value);
        assert.equal(admitted, namespaceStage === stage, `${program.name}/${machine}: ${namespaceStage} namespace choosing ${stage} role`);
      }
    }
  }
});

test('planted missing stage fences, explicit namespace bypasses and foreign stages are rejected', () => {
  const safe = {bound_service_account_names: ['external-secrets-sa'], bound_service_account_namespaces: [], ttl: '24h',
    bound_service_account_namespace_selector: JSON.stringify({matchLabels: {'platform/tenant-managed': 'true', 'platform/tenant-stage': 'test'}})};
  stageRole(safe, 'test');
  for (const changed of [
    {bound_service_account_namespaces: ['*']},
    {bound_service_account_namespace_selector: JSON.stringify({matchLabels: {'platform/tenant-managed': 'true'}})},
    {bound_service_account_namespace_selector: JSON.stringify({matchLabels: {'platform/tenant-managed': 'true', 'platform/tenant-stage': 'prod'}})},
    {bound_service_account_names: ['*']},
  ]) assert.throws(() => stageRole({...safe, ...changed}, 'test'));
});

test('native slave removal deletes every policy provisioned for all machine stages', () => {
  const inverse = removal.steps.filter(row => row.step === 'remove_vault_policy');
  for (const machine of stages) {
    for (const policy of programs[0].steps.filter(row => active(row, machine) && row.step === 'vault_policy' && row.name.includes('-tenant-read'))) {
      assert.ok(inverse.some(row => row.name === policy.name && !(row.when ?? []).length), `${machine}: orphaned ${policy.name}`);
    }
  }
});

test('focused refresh uses the provisioning tenant rows and touches only tenant policies and roles', () => {
  const [slave, bootstrap, refresh] = programs;
  assert.deepEqual(refresh.roles, ['master']);
  assert.deepEqual(refresh.answers.map(answer => answer.name), ['fqdn', 'stage']);
  for (const [key, value] of Object.entries(refresh.defaults)) assert.deepEqual(value, bootstrap.defaults[key]);
  const tenantRow = row => row.step === 'vault_policy' ? row.name.includes('-tenant-read') : row.step === 'vault_auth_role' && row.role.startsWith('tenant-eso-');
  const writesOnlyTenantAccess = program => {
    assert.equal(program.steps.length, 8);
    for (const row of program.steps) {
      assert.ok(tenantRow(row));
      assert.equal(row.repository, '/srv/hostyour-cloud');
      assert.equal(row.on_failure, 'exit');
    }
  };
  writesOnlyTenantAccess(refresh);
  assert.throws(() => writesOnlyTenantAccess({...refresh, steps: [...refresh.steps, {step: 'vault_kv_entry'}]}));
  assert.throws(() => writesOnlyTenantAccess(slave));
  for (const row of refresh.steps) {
    const parent = bootstrap.steps.find(candidate => candidate.step === row.step && candidate.name === row.name && candidate.role === row.role);
    assert.ok(parent);
    const {when: _when, rests_on_an_earlier_step: _rests, ...definition} = row;
    const {when: _parentWhen, rests_on_an_earlier_step: _parentRests, ...parentDefinition} = parent;
    assert.deepEqual(definition, parentDefinition);
    assert.deepEqual(row.when ?? [], (parent.when ?? []).filter(name => name.startsWith('stage_is_not_')));
  }
});
