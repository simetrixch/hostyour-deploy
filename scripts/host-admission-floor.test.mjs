import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ansiwiseRun} from './ansiwise-run.mjs';

const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-host.yaml', import.meta.url))], {encoding: 'utf8'}));
const rows = program.steps.filter(row => row.step === 'require_machine_size');
// The comparison ansiwise-host require_machine_size.dart makes: refused below either figure, admitted at both.
const admits = (row, machine) => machine.processors >= row.vcpu && machine.memTotalKibibytes >= row.memory_kibibytes;

// What an app host must schedule, by requests, measured on apps3 on 2026-10-04: the platform's own pods,
// one tenant shaped like the company tenant at the XS size, and the kubelet's hard-eviction reserve that
// allocatable memory lacks against MemTotal.
const platform = {millicores: 2140, kibibytes: 4849664};
const xsTenant = {millicores: 290, kibibytes: 1474560};
const evictionReserveKibibytes = 102400;
const floor = {
  processors: Math.ceil((platform.millicores + xsTenant.millicores) / 1000),
  memTotalKibibytes: platform.kibibytes + xsTenant.kibibytes + evictionReserveKibibytes,
};

test('deploy-host admits a machine exactly at the platform-plus-XS floor and refuses one below it', () => {
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.on_failure, 'exit');
  assert.ok(admits(row, floor), `a machine at ${floor.processors} processors and ${floor.memTotalKibibytes} KiB is refused`);
  assert.ok(admits(row, {processors: 24, memTotalKibibytes: 63737464}), 'an apps2-sized machine is refused');
  for (const below of [
    {processors: 2, memTotalKibibytes: 4000000},
    {processors: floor.processors - 1, memTotalKibibytes: floor.memTotalKibibytes},
    {processors: floor.processors, memTotalKibibytes: floor.memTotalKibibytes - 1},
  ]) {
    assert.ok(!admits(row, below), `a machine at ${below.processors} processors and ${below.memTotalKibibytes} KiB is admitted`);
  }
});

// THE MASTER'S OWN FLOOR, the first row of deploy-branch, which only a master runs. The owner's
// masters are never below 8 processors and 16 GB. What a master schedules, by requests, measured on
// master1 on 2026-10-05: its own pods (the slave part included), one release of the widest unit on
// record (three image builds at once) and one XS tenant, plus the eviction reserve.
const branch = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-branch.yaml', import.meta.url))], {encoding: 'utf8'}));
const masterNeed = {
  millicores: 3270 + 2250 + xsTenant.millicores,
  memTotalKibibytes: 8208384 + 4718592 + xsTenant.kibibytes + evictionReserveKibibytes,
};

test('deploy-branch refuses a master below 8 processors and the 14,503,936 KiB it schedules, before its first other row', () => {
  const [first] = branch.steps;
  assert.equal(first.step, 'require_machine_size');
  assert.equal(first.on_failure, 'exit');
  assert.equal(first.when, undefined);
  assert.equal(branch.steps.filter(row => row.step === 'require_machine_size').length, 1);
  // master1 as measured: 32 processors and 62,416,164 KiB.
  assert.ok(admits(first, {processors: 32, memTotalKibibytes: 62416164}), 'master1 is refused');
  assert.ok(admits(first, {processors: 8, memTotalKibibytes: masterNeed.memTotalKibibytes}), 'a machine at the floor is refused');
  // A machine sold as 16 GB: 16 GiB, or 16,000,000,000 bytes, each at master1's 7 percent shortfall.
  for (const memTotalKibibytes of [15600000, 14600000]) {
    assert.ok(admits(first, {processors: 8, memTotalKibibytes}), `a 16 GB machine reporting ${memTotalKibibytes} KiB is refused`);
  }
  for (const below of [
    {processors: 5, memTotalKibibytes: 62416164},
    {processors: 7, memTotalKibibytes: 62416164},
    {processors: 8, memTotalKibibytes: masterNeed.memTotalKibibytes - 1},
    {processors: 8, memTotalKibibytes: 11600000},
    {processors: floor.processors, memTotalKibibytes: floor.memTotalKibibytes},
  ]) {
    assert.ok(!admits(first, below), `a master at ${below.processors} processors and ${below.memTotalKibibytes} KiB is admitted`);
  }
  // The floor is what a master schedules.
  assert.ok(first.vcpu * 1000 >= masterNeed.millicores);
  assert.equal(first.memory_kibibytes, masterNeed.memTotalKibibytes);
});

// THE TREE EVERY LATER PROGRAM ACTS ON IS CLONED FROM WHERE THE RUN'S TWO ANSWERS PUT IT. Two rows,
// and the two conditions of ansiwise.yaml choose between them: the platform repository is still on
// github.com while `platform_repo` and `forgejo_platform_repository` name different repositories, and
// on this installation's Forgejo, read with a credential because it is private, once they name the same.
const installation = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise.yaml', import.meta.url))], {encoding: 'utf8'}));
const cloneOf = steps => steps.filter(row => row.step === 'git_clone' && row.repository === '/srv/hostyour-cloud');
const credentialArguments = ['credential_answer', 'credential_user', 'credential_file', 'credential_key'];

function assertPlatformClones(definition, conditions) {
  const clones = cloneOf(definition.steps);
  const github = clones.find(row => row.when?.includes('platform_on_github_in_answers'));
  const forgejo = clones.find(row => row.when?.includes('platform_on_forgejo_in_answers'));
  assert.ok(github && forgejo && clones.length === 2, 'deploy-host clones /srv/hostyour-cloud in exactly two rows, one chosen by each condition');
  for (const row of [github, forgejo]) {
    assert.equal(row.on_failure, 'exit');
    assert.equal(row.branch_answer, 'platform_branch');
    assert.equal(row.owner_answer, 'operator_user');
    assert.equal(row.elevated, undefined, 'a credential beside elevated is refused by the step');
  }
  assert.deepEqual(github.when, ['platform_on_github_in_answers']);
  assert.equal(github.host, 'github.com');
  assert.equal(github.host_answer, undefined);
  assert.equal(github.origin_answer, 'platform_repo');
  for (const name of credentialArguments) assert.equal(github[name], undefined, `the GitHub row names ${name}, and that repository is served to anybody`);
  assert.deepEqual(forgejo.when, ['platform_on_forgejo_in_answers']);
  assert.equal(forgejo.host, undefined, 'the Forgejo host is an answer, not a word of the program');
  assert.equal(forgejo.host_answer, 'forgejo_host');
  assert.equal(forgejo.origin_answer, 'forgejo_platform_repository');
  assert.equal(forgejo.credential_answer, 'platform_repo_read_pat');
  assert.equal(forgejo.credential_user, 'oauth2');
  assert.equal(forgejo.credential_file, undefined);
  assert.deepEqual(conditions.platform_on_forgejo_in_answers,
    {predicate: 'answer_values_agree', answer: 'platform_repo', other_answer: 'forgejo_platform_repository'});
  assert.deepEqual(conditions.platform_on_github_in_answers,
    {predicate: 'answer_values_differ', answer: 'platform_repo', other_answer: 'forgejo_platform_repository'});
  const declared = name => definition.answers.find(answer => answer.name === name);
  assert.equal(declared('forgejo_platform_repository')?.required, true);
  assert.equal(declared('forgejo_host')?.required, true);
  assert.equal(declared('forgejo_host')?.shape, 'hostname');
  assert.equal(declared('platform_repo_read_pat')?.secret, true);
  assert.equal(declared('platform_repo_read_pat')?.required, false);
  assert.equal(declared('platform_repo_read_pat')?.stated_when, undefined, 'a github.com run handed its reader must still be accepted');
}

test('deploy-host clones the platform repository in a GitHub row and a Forgejo row that a condition each chooses', () => {
  assertPlatformClones(program, installation.conditions);
});

test('PLANTED DEFECTS: each way the two clone rows can stop agreeing with the conditions is refused', () => {
  const planted = [
    ['the Forgejo row names the host as a word', p => { const row = cloneOf(p.steps)[1]; row.host = 'forgejo.example.invalid'; delete row.host_answer; }],
    ['the Forgejo row reads the GitHub repository answer', p => { cloneOf(p.steps)[1].origin_answer = 'platform_repo'; }],
    ['the Forgejo row reads no credential', p => { for (const name of credentialArguments) delete cloneOf(p.steps)[1][name]; }],
    ['the Forgejo row reads the credential under another account', p => { cloneOf(p.steps)[1].credential_user = 'x-access-token'; }],
    ['the Forgejo row is elevated', p => { cloneOf(p.steps)[1].elevated = true; }],
    ['the GitHub row carries a credential', p => { Object.assign(cloneOf(p.steps)[0], {credential_answer: 'platform_repo_read_pat', credential_user: 'oauth2'}); }],
    ['the GitHub row is not chosen by a condition', p => { delete cloneOf(p.steps)[0].when; }],
    ['both rows are chosen by the same condition', p => { cloneOf(p.steps)[1].when = ['platform_on_github_in_answers']; }],
    ['a third clone row', p => p.steps.push(structuredClone(cloneOf(p.steps)[0]))],
    ['the Forgejo host answer is not declared', p => { p.answers = p.answers.filter(answer => answer.name !== 'forgejo_host'); }],
    ['the read credential is stated only under a condition', p => { p.answers.find(answer => answer.name === 'platform_repo_read_pat').stated_when = {predicate: 'platform_on_forgejo_in_answers'}; }],
  ];
  for (const [name, change] of planted) {
    const changed = structuredClone(program); change(changed);
    assert.throws(() => assertPlatformClones(changed, installation.conditions), undefined, name);
  }
  const conditions = structuredClone(installation.conditions);
  conditions.platform_on_forgejo_in_answers.predicate = 'answer_values_differ';
  assert.throws(() => assertPlatformClones(program, conditions), undefined, 'the Forgejo condition reads the wrong way round');
  const innocent = structuredClone(program);
  innocent.answers.find(answer => answer.name === 'forgejo_host').describes += ' Spelled as the Manager spells it.';
  innocent.steps.splice(0, 0, ...innocent.steps.splice(innocent.steps.indexOf(cloneOf(innocent.steps)[1]), 1));
  assertPlatformClones(innocent, installation.conditions);
});

// THE REAL CLI CHOOSES BETWEEN THE ROWS. The rows below are the program's own, run by the binary in
// the mode that changes nothing, against a clone directory that does not exist yet, so the plan names the
// address the clone would read. `owner_answer` is left off the copies: handing the directory to an
// account is a command run as root, which this run holds no password for, and it is not what is chosen here.
const READ_CREDENTIAL = 'fixture-read-credential-never-printed';
const platformAnswers = {platform_repo: 'org/platform', forgejo_platform_repository: 'forge-org/platform',
  forgejo_host: 'forgejo.example.invalid', platform_branch: 'master', operator_user: 'operator'};

function dryClone(definition, answers) {
  const dir = mkdtempSync(join(tmpdir(), 'platform-clone-'));
  try {
    const mini = {
      name: 'deploy-host', roles: ['master', 'slave'],
      answers: definition.answers.filter(answer => Object.hasOwn(platformAnswers, answer.name) || answer.name === 'platform_repo_read_pat'),
      steps: cloneOf(definition.steps).map(row => { const copy = {...row, repository: join(dir, 'hostyour-cloud')}; delete copy.owner_answer; return copy; }),
    };
    const result = ansiwiseRun({definition: mini, config: fileURLToPath(new URL('../ansiwise.yaml', import.meta.url)), modes: ['dry'], answers});
    const planned = result.events.filter(event => event.kind === 'planned').map(event => event.plan.argv.at(-2));
    const skipped = result.events.filter(event => event.kind === 'step-finished' && event.verdict.label === 'skipped').map(event => event.verdict.predicate);
    return {...result, planned, skipped};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('REAL CLI: the Forgejo answers clone from Forgejo with the credential, today\'s answers from GitHub, and no credential is refused by name', () => {
  const forgejo = dryClone(program, {...platformAnswers, platform_repo: 'forge-org/platform', platform_repo_read_pat: READ_CREDENTIAL});
  assert.equal(forgejo.code, 0, forgejo.output);
  assert.deepEqual(forgejo.planned, ['https://forgejo.example.invalid/forge-org/platform.git']);
  assert.deepEqual(forgejo.skipped, ['platform_on_github_in_answers']);
  assert.ok(!(forgejo.output + JSON.stringify(forgejo.events)).includes(READ_CREDENTIAL), 'the read credential reached the output or the record');

  const github = dryClone(program, {...platformAnswers, platform_repo_read_pat: READ_CREDENTIAL});
  assert.equal(github.code, 0, github.output);
  assert.deepEqual(github.planned, ['https://github.com/org/platform.git']);
  assert.deepEqual(github.skipped, ['platform_on_forgejo_in_answers']);

  const withoutCredential = dryClone(program, {...platformAnswers, platform_repo: 'forge-org/platform'});
  assert.notEqual(withoutCredential.code, 0, withoutCredential.output);
  assert.ok(JSON.stringify(withoutCredential.events).includes('platform_repo_read_pat'), 'the refusal does not name the answer');
});

test('PLANTED DEFECT, REAL CLI: a Forgejo row gated on the GitHub condition clones the Forgejo answers from GitHub', () => {
  const swapped = structuredClone(program);
  const [github, forgejo] = cloneOf(swapped.steps);
  [github.when, forgejo.when] = [forgejo.when, github.when];
  const result = dryClone(swapped, {...platformAnswers, platform_repo: 'forge-org/platform', platform_repo_read_pat: READ_CREDENTIAL});
  assert.throws(() => assert.deepEqual(result.planned, ['https://forgejo.example.invalid/forge-org/platform.git']));
});
