import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(execFileSync('yq', ['-o=json', '.', root + path], {encoding: 'utf8'}));
const program = read('ansiwise/programs/deploy-platform-services.yaml');
const config = read('ansiwise.yaml');
function assertNoPasswordPersistence(value) {
  assert.equal(JSON.stringify(value).includes('elevation_password'), false, 'the program declares or consumes the caller password as an answer');
}

test('platform deployment neither declares nor consumes a persistable elevation-password answer', () => {
  assertNoPasswordPersistence(program);
});
test('PLANTED DEFECT: restoring the unused password declaration turns the check red', () => {
  const changed = structuredClone(program);
  changed.answers.push({name: 'elevation_password', kind: 'text', secret: true});
  assert.throws(() => assertNoPasswordPersistence(changed), /declares or consumes/);
});
test('PLANTED DEFECT: adding a password writer without a declaration turns the check red', () => {
  const changed = structuredClone(program);
  changed.steps.push({step: 'vault_fill', fields_from_answers: ['sudo-password=elevation_password']});
  assert.throws(() => assertNoPasswordPersistence(changed), /declares or consumes/);
});
test('PLANTED INNOCENT: caller elevation and unrelated secret answers remain supported', () => {
  assert.equal(config.elevation.password_from_caller, true);
  assert.equal(Object.hasOwn(config.elevation, 'password_file'), false);
  assertNoPasswordPersistence({...program, answers: [...program.answers, {name: 'unrelated_token', secret: true}]});
});
