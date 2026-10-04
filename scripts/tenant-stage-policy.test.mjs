import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const stages = ['dev', 'test', 'prod'];
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', fileURLToPath(new URL('../' + file, import.meta.url))], {encoding: 'utf8'}));
const conditions = read('ansiwise.yaml').conditions;
const programs = ['register-slave', 'deploy-platform-services'].map(name => read(`ansiwise/programs/${name}.yaml`));
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
