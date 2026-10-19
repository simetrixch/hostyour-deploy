import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, mkdirSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = path => JSON.parse(execFileSync('yq', ['-o=json', '.', join(root, path)], {encoding: 'utf8'}));
const branch = read('ansiwise/programs/deploy-branch.yaml');
const services = read('ansiwise/programs/deploy-platform-services.yaml');
const names = ['forgejo_platform_repository', 'forgejo_deploy_repository', 'forgejo_organisations'];
const valid = {forgejo_platform_repository: 'platform-team/platform', forgejo_deploy_repository: 'deploy-team/deploy', forgejo_organisations: 'platform-team,deploy-team'};
const checks = program => program.steps.filter(s => s.step === 'require_answer_matches' && names.includes(s.answer));

// deploy-branch refuses a master below its floor before any other row, so its Forgejo rows follow that one.
function contract(program, start) {
  for (const name of names) {
    assert.equal(program.answers.find(a => a.name === name)?.required, true, name);
    const row = checks(program).find(s => s.answer === name);
    assert.ok(row, `no validation for ${name}`);
    assert.equal(row.on_failure, 'exit');
    assert.equal(row.when, undefined);
    assert.equal(program.steps.indexOf(row), start + names.indexOf(name));
    assert.match(valid[name], new RegExp(row.pattern));
    assert.doesNotMatch('', new RegExp(row.pattern));
    for (const value of name === 'forgejo_organisations' ? ['one,,two', ',one', 'one,', 'one, two', 'one\n'] : ['one/', '/two', 'one/two/three', '../two', 'one/two\n', "one/a'b"]) {
      assert.doesNotMatch(value, new RegExp(row.pattern), `${name}: ${JSON.stringify(value)}`);
    }
  }
}

test('both entry points require and validate Forgejo destinations before any mutable row', () => {
  contract(branch, 1); contract(services, 0);
  for (const change of [p => { p.answers.find(a => a.name === names[0]).required = false; }, p => p.steps.splice(1, 1), p => p.steps.push(...p.steps.splice(1, 1)), p => p.steps.unshift(...p.steps.splice(1, 3)), p => { checks(p)[0].pattern = '.*'; }]) {
    const planted = structuredClone(branch); change(planted);
    assert.throws(() => contract(planted, 1));
  }
  const innocent = structuredClone(branch); checks(innocent)[0].refusal += ' Please check the installation.';
  contract(innocent, 1);
});

test('the installation file carries only configured destinations and the Forgejo host', () => {
  const row = branch.steps.find(s => s.path === '/srv/hostyour-cloud/installation/values/repository-credentials.yaml');
  assert.ok(row, 'no persisted configuration');
  assert.equal(row.template, 'ansiwise/templates/repository-credentials-values.tpl');
  assert.equal(row.when, undefined);
  assert.equal(row.file_mode, 420);
  assert.deepEqual(row.values, {
    'forgejo-host': {answer: 'forgejo_host'}, 'forgejo-platform-repository': {answer: names[0]},
    'forgejo-deploy-repository': {answer: names[1]}, 'forgejo-organisations': {answer: names[2]},
  });
  const template = readFileSync(join(root, row.template), 'utf8');
  const rendered = template.replace(/<([a-z][a-z0-9-]*)>/g, (_, key) => ({'forgejo-host': 'forgejo.master.example.invalid', ...Object.fromEntries(Object.entries(row.values).filter(([key]) => key !== 'forgejo-host').map(([key, value]) => [key, valid[value.answer]]))})[key]);
  const dir = mkdtempSync(join(tmpdir(), 'repository-credentials-'));
  try {
    const path = join(dir, 'values.yaml'); writeFileSync(path, rendered);
    const parsed = JSON.parse(execFileSync('yq', ['-o=json', '.', path], {encoding: 'utf8'}));
    assert.deepEqual(parsed, {global: {repositoryCredentials: {forgejo: {
      enabled: true, host: 'forgejo.master.example.invalid', platformRepository: valid[names[0]],
      deployRepository: valid[names[1]], organisations: valid[names[2]],
    }}}});
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

async function dry(program, answers) {
  const dir = mkdtempSync(join(tmpdir(), 'forgejo-answers-'));
  try {
    mkdirSync(join(dir, 'programs'));
    writeFileSync(join(dir, 'programs', program.name + '.yaml'), JSON.stringify({
      name: program.name, roles: ['master', 'slave'],
      answers: program.answers.filter(a => names.includes(a.name)), steps: checks(program),
    }));
    writeFileSync(join(dir, 'config.yaml'), 'log_level: info\nplugins: [ansiwise-host]\n');
    const cli = process.env.ANSIWISE_CLI_CHECKOUT;
    const binary = process.env.ANSIWISE_BIN;
    assert.ok(binary || cli, 'set ANSIWISE_BIN or ANSIWISE_CLI_CHECKOUT; real-CLI coverage may not skip');
    const args = [program.name, '--mode', 'dry', '--config', join(dir, 'config.yaml'), '--programs', join(dir, 'programs'), '--runs', join(dir, 'runs'), '--answers', '-', '--without-elevation-password'];
    const child = spawn(binary || 'dart', binary ? args : ['run', 'bin/ansiwise.dart', ...args], {cwd: binary ? dir : cli});
    let output = '';
    child.stdout.on('data', b => { output += b; }); child.stderr.on('data', b => { output += b; });
    const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve); child.stdin.end(JSON.stringify({answers})); });
    for (const path of (existsSync(join(dir, 'runs')) ? readdirSync(join(dir, 'runs'), {recursive: true}) : [])) {
      if (/\.(json|jsonl|log)$/.test(path)) output += readFileSync(join(dir, 'runs', path), 'utf8');
    }
    return {code, output};
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

test('REAL CLI: production input rows reject missing, empty and malformed values; complete and equal repositories pass', async () => {
  for (const program of [branch, services]) {
    assert.equal((await dry(program, valid)).code, 0);
    assert.equal((await dry(program, {...valid, forgejo_deploy_repository: valid.forgejo_platform_repository})).code, 0);
    for (const name of names) {
      for (const value of [undefined, '', name === names[2] ? 'one,,two' : 'one/']) {
        const result = await dry(program, {...valid, [name]: value});
        assert.notEqual(result.code, 0, `${program.name}: accepted ${name}=${value}`);
        assert.ok(result.output.includes(name), result.output);
      }
    }
  }
});

// THE PLATFORM REPOSITORY'S FORGE IS CHOSEN BY CONDITIONS OVER ANSWERS, so every condition has to be
// answerable in every program whose rows name it, and the read credential has to reach a remote on Forgejo only.
const installation = read('ansiwise.yaml');
const hostProgram = read('ansiwise/programs/deploy-host.yaml');
const platformConditions = {platform_on_forgejo_in_answers: 'answer_values_agree', platform_on_github_in_answers: 'answer_values_differ'};
const branchConditions = ['install_branch_published', 'install_branch_unpublished'];
const namesIn = (program, condition) => program.steps.some(step => step.when?.includes(condition));

function assertConditionsAnswerable(conditions, programs) {
  for (const [name, predicate] of Object.entries(platformConditions)) {
    assert.deepEqual(conditions[name], {predicate, answer: 'platform_repo', other_answer: 'forgejo_platform_repository'}, name);
    for (const program of programs.filter(candidate => namesIn(candidate, name))) {
      for (const answer of [conditions[name].answer, conditions[name].other_answer]) {
        assert.ok(program.answers.some(declared => declared.name === answer), `${program.name} names ${name} and does not declare ${answer}`);
      }
    }
  }
  assert.ok(programs.some(program => namesIn(program, 'platform_on_forgejo_in_answers')), 'no program names the Forgejo condition');
}

// WHERE THE READ CREDENTIAL IS PRESENTED. Every condition of a program is measured before its first step, so
// a condition that names a credential presents it on github.com as well. The two install-branch conditions
// therefore name none, and the one row that puts the read credential in the checkout is deploy-host's,
// selected on Forgejo alone.
const READ = 'platform_repo_read_pat';
const hasCredential = row => row.credential_answer !== undefined || row.credential_user !== undefined;
const selectedFor = (program, held) => program.steps.filter(step => (step.when ?? []).every(name => held.includes(name)));

function assertCredentialOnForgejoOnly(conditions, host) {
  for (const name of branchConditions) {
    assert.equal(hasCredential(conditions[name]), false, `${name} presents a credential to every remote it asks, github.com among them`);
  }
  const forgejoClone = host.steps.findIndex(step => step.step === 'git_clone' && step.when?.includes('platform_on_forgejo_in_answers'));
  assert.ok(forgejoClone >= 0, 'deploy-host has no Forgejo clone row');
  const helpers = host.steps.filter(step => step.step === 'git_push_credential');
  assert.equal(helpers.length, 1, 'deploy-host writes the read credential with exactly one row');
  const [helper] = helpers;
  assert.deepEqual(helper.when, ['platform_on_forgejo_in_answers']);
  assert.deepEqual([helper.credential_answer, helper.credential_user, helper.repository, helper.remote, helper.on_failure], [READ, 'oauth2', '/srv/hostyour-cloud', 'origin', 'exit']);
  assert.ok(host.steps.indexOf(helper) > forgejoClone, 'the helper row stands before the clone that makes the checkout');
  assert.ok(host.answers.some(declared => declared.name === READ), `deploy-host does not declare ${READ}`);
  const github = host.steps.find(step => step.step === 'git_clone' && step.when?.includes('platform_on_github_in_answers'));
  assert.equal(hasCredential(github), false, 'the github.com clone row names a credential');
  assert.equal(host.steps.filter(step => step.credential_answer === READ && !step.when?.includes('platform_on_forgejo_in_answers')).length, 0, 'a row presents the read credential outside Forgejo');
}

test('the platform conditions are answerable in every program that names them', () => {
  assertConditionsAnswerable(installation.conditions, [hostProgram, branch]);
});

test('PLANTED DEFECT: a condition over an answer the program does not declare is refused', () => {
  const undeclared = structuredClone(hostProgram);
  undeclared.answers = undeclared.answers.filter(answer => answer.name !== 'forgejo_platform_repository');
  assert.throws(() => assertConditionsAnswerable(installation.conditions, [undeclared, branch]), /does not declare forgejo_platform_repository/);
  const unnamed = structuredClone(installation.conditions);
  delete unnamed.platform_on_github_in_answers;
  assert.throws(() => assertConditionsAnswerable(unnamed, [hostProgram, branch]));
});

test('the read credential is presented on Forgejo and never on github.com', () => {
  assertCredentialOnForgejoOnly(installation.conditions, hostProgram);
  // WHAT A RUN SELECTS. A github.com run is the one whose two platform answers name different repositories.
  const github = selectedFor(hostProgram, ['platform_on_github_in_answers']);
  assert.deepEqual(github.filter(hasCredential), [], 'a github.com run selects a row that presents a credential');
  assert.deepEqual(github.filter(step => step.step === 'git_push_credential'), [], 'a github.com run writes a credential helper');
  const forgejo = selectedFor(hostProgram, ['platform_on_forgejo_in_answers']);
  assert.deepEqual(forgejo.filter(hasCredential).map(step => step.step), ['git_clone', 'git_push_credential']);
});

test('PLANTED DEFECT: a credential on a condition, a helper row off Forgejo, and a credentialed github.com clone are each refused', () => {
  const onCondition = structuredClone(installation.conditions);
  onCondition.install_branch_published.credential_answer = READ;
  onCondition.install_branch_published.credential_user = 'oauth2';
  assert.throws(() => assertCredentialOnForgejoOnly(onCondition, hostProgram), /presents a credential to every remote/);
  const everywhere = structuredClone(hostProgram);
  delete everywhere.steps.find(step => step.step === 'git_push_credential').when;
  assert.throws(() => assertCredentialOnForgejoOnly(installation.conditions, everywhere), /deepEqual|Expected values/i);
  const onGithub = structuredClone(hostProgram);
  onGithub.steps.find(step => step.step === 'git_push_credential').when = ['platform_on_github_in_answers'];
  assert.throws(() => assertCredentialOnForgejoOnly(installation.conditions, onGithub));
  assert.notDeepEqual(selectedFor(onGithub, ['platform_on_github_in_answers']).filter(hasCredential), [], 'the planted host does not select the helper on github.com, so the case cannot go red');
  const credentialed = structuredClone(hostProgram);
  Object.assign(credentialed.steps.find(step => step.step === 'git_clone' && step.when?.includes('platform_on_github_in_answers')), {credential_answer: READ, credential_user: 'oauth2'});
  assert.throws(() => assertCredentialOnForgejoOnly(installation.conditions, credentialed), /github.com clone row names a credential/);
  const unread = structuredClone(hostProgram);
  unread.answers = unread.answers.filter(answer => answer.name !== READ);
  assert.throws(() => assertCredentialOnForgejoOnly(installation.conditions, unread), /does not declare/);
});

test('PLANTED INNOCENT: the conditions as they stand, with a reworded description, stay accepted', () => {
  const reworded = structuredClone(hostProgram);
  reworded.answers.find(answer => answer.name === 'forgejo_host').describes += ' Reworded.';
  assertConditionsAnswerable(installation.conditions, [reworded, branch]);
  assertCredentialOnForgejoOnly(installation.conditions, hostProgram);
});
