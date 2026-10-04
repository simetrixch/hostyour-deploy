import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const program = file => JSON.parse(execFileSync('yq', ['-o=json', '.', fileURLToPath(new URL('../' + file, import.meta.url))], {encoding: 'utf8'}));
const focused = program('ansiwise/programs/configure-tekton-reporter.yaml');
const installation = program('ansiwise/programs/deploy-platform-services.yaml');
const policy = focused.steps.find(row => row.step === 'vault_policy');
const role = focused.steps.find(row => row.step === 'vault_auth_role');

test('reporter reads exactly the App leaf, with no wildcard or write', () => {
  assert.equal(policy.rules.trim(), 'path "secret/data/<stage>/app/digita-tekton-reporter" { capabilities = ["read"] }');
  assert.equal(policy.name, '<cluster>-tekton-reporter-read');
});
test('reporter login binds only its dedicated account and build-plane namespace', () => {
  assert.deepEqual(JSON.parse(role.body), {
    bound_service_account_names: ['tekton-reporter-eso'],
    bound_service_account_namespaces: ['image-builder'],
    token_policies: ['<cluster>-tekton-reporter-read'], ttl: '1h',
  });
  assert.equal(role.role, 'tekton-reporter-eso');
  assert.equal(role.mount, '<kubernetes-mount>');
});
test('focused update and normal installation keep identical identity grants', () => {
  assert.equal(focused.steps.length, 2);
  for (const row of focused.steps) {
    const match = installation.steps.filter(candidate => candidate.step === row.step &&
      (candidate.name === row.name && candidate.role === row.role));
    assert.equal(match.length, 1);
    const {rests_on_an_earlier_step, ...installedGrant} = match[0];
    assert.equal(rests_on_an_earlier_step, true);
    assert.deepEqual(installedGrant, row);
    assert.equal(row.rests_on_an_earlier_step, undefined);
    assert.equal(row.on_failure, 'exit');
    assert.deepEqual(row.when, ['secret_store_enabled', 'build_plane_here_in_answers', 'books_here_in_answers']);
  }
});
test('focused conditions have every declared answer they need', () => {
  const answers = Object.fromEntries(focused.answers.map(answer => [answer.name, answer]));
  for (const name of ['fqdn', 'stage', 'books_fqdn', 'build_plane_fqdn']) assert.ok(answers[name]);
  assert.equal(answers.books_fqdn.default_from, 'fqdn');
  assert.equal(answers.build_plane_fqdn.required, undefined);
});
