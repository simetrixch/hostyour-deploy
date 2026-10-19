import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The master's ssh to a slave runs with host key checking on, so the slave's host key has to stand in
// the master user's known hosts. register-slave is the program that puts it there: the key arrives as
// an answer the Manager proved, and the step installs it. The contract is that the row exists, that it
// names answers the program declares, and that nothing in the catalog turns the check off.

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(execFileSync('yq', ['-o=json', '.', root + path], {encoding: 'utf8'}));
const program = read('ansiwise/programs/register-slave.yaml');
const config = read('ansiwise.yaml');

const declared = value => new Set(value.answers.map(answer => answer.name));

function assertKnownHostRow(value) {
  const rows = value.steps.filter(row => row.step === 'install_known_host');
  assert.equal(rows.length, 1, 'the program has no install_known_host row, or has more than one');
  const [row] = rows;
  const names = declared(value);
  for (const field of ['host_answer', 'host_public_key_answer']) {
    assert.equal(typeof row[field], 'string', `the row does not name ${field}`);
    assert.ok(names.has(row[field]), `the row names the answer ${row[field]} in ${field}, which the program does not declare`);
  }
  assert.ok(names.has('operator_user'), 'the account whose known hosts take the key is not a declared answer');
  assert.equal(row.on_failure, 'exit', 'a failed install must stop the run, or the master is left unable to reach the slave and says it registered it');
}

const bypasses = /StrictHostKeyChecking|UserKnownHostsFile|ssh-keyscan/;

function filesUnder(directory) {
  return readdirSync(root + directory, {withFileTypes: true, recursive: true})
    .filter(entry => entry.isFile())
    .map(entry => `${entry.parentPath.slice(root.length)}/${entry.name}`);
}

function assertNoBypass(texts) {
  for (const [name, text] of Object.entries(texts)) {
    assert.equal(bypasses.test(text), false, `${name} turns host key checking off or fills known hosts blind`);
  }
}

test('register-slave installs the slave host key under answers it declares', () => {
  assertKnownHostRow(program);
});

test('the row names the answers the Manager sends, so one machine and one key reach it', () => {
  const row = program.steps.find(step => step.step === 'install_known_host');
  assert.equal(row.host_answer, 'slave_ssh_host');
  assert.equal(row.host_public_key_answer, 'slave_host_key');
});

test('the key answer is public text and is not declared secret, so a plan an operator reads shows it', () => {
  const key = program.answers.find(answer => answer.name === 'slave_host_key');
  assert.equal(key.kind, 'text');
  assert.notEqual(key.secret, true);
});

test('the engine loads the plugin the row comes from', () => {
  assert.ok(config.plugins.includes('ansiwise-host'));
});

test('PLANTED DEFECT: a program without the row turns the check red', () => {
  const changed = structuredClone(program);
  changed.steps = changed.steps.filter(row => row.step !== 'install_known_host');
  assert.throws(() => assertKnownHostRow(changed), /no install_known_host row/);
});

test('PLANTED DEFECT: a program that does not declare slave_host_key turns the check red', () => {
  const changed = structuredClone(program);
  changed.answers = changed.answers.filter(answer => answer.name !== 'slave_host_key');
  assert.throws(() => assertKnownHostRow(changed), /slave_host_key.*does not declare/);
});

test('PLANTED DEFECT: a row naming an answer the program never declares turns the check red', () => {
  const changed = structuredClone(program);
  changed.steps.find(row => row.step === 'install_known_host').host_answer = 'slave_ssh_hostname';
  assert.throws(() => assertKnownHostRow(changed), /slave_ssh_hostname.*does not declare/);
});

test('PLANTED DEFECT: a program without the master account answer turns the check red', () => {
  const changed = structuredClone(program);
  changed.answers = changed.answers.filter(answer => answer.name !== 'operator_user');
  assert.throws(() => assertKnownHostRow(changed), /operator_user|account/);
});

test('PLANTED DEFECT: a row that lets a failed install pass turns the check red', () => {
  const changed = structuredClone(program);
  changed.steps.find(row => row.step === 'install_known_host').on_failure = 'continue';
  assert.throws(() => assertKnownHostRow(changed), /must stop the run/);
});

test('no program or template of the catalog turns host key checking off or fills known hosts blind', () => {
  const texts = Object.fromEntries(
    ['ansiwise/programs', 'ansiwise/boot-programs', 'ansiwise/templates'].flatMap(filesUnder).map(path => [path, readFileSync(root + path, 'utf8')]),
  );
  assert.ok(Object.keys(texts).length > 20, 'the catalog was not read');
  assertNoBypass(texts);
});

test('PLANTED DEFECT: each way of turning the check off is found', () => {
  for (const line of ['ssh -o StrictHostKeyChecking=no master@apps2', 'ssh -o UserKnownHostsFile=/dev/null master@apps2', 'ssh-keyscan apps2 >> ~/.ssh/known_hosts']) {
    assert.throws(() => assertNoBypass({'a program': `- step: run_command\n  command: ${line}\n`}), /turns host key checking off/);
  }
});

test('PLANTED INNOCENT: a program that names known hosts and ssh in prose is not a bypass', () => {
  assertNoBypass({'a program': '# the master reaches the slave over ssh with host key checking on, and its known hosts hold the slave key\n'});
});

test('PLANTED INNOCENT: the program keeps passing when it gains an unrelated answer and row', () => {
  const changed = structuredClone(program);
  changed.answers.push({name: 'unrelated_value', kind: 'text'});
  changed.steps.push({step: 'require_commands', commands: ['microk8s'], on_failure: 'exit'});
  assertKnownHostRow(changed);
});
