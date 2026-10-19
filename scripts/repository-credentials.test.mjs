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
    fqdn: {answer: 'fqdn'}, 'forgejo-platform-repository': {answer: names[0]},
    'forgejo-deploy-repository': {answer: names[1]}, 'forgejo-organisations': {answer: names[2]},
  });
  const template = readFileSync(join(root, row.template), 'utf8');
  const rendered = template.replace(/<([a-z][a-z0-9-]*)>/g, (_, key) => ({'fqdn': 'master.example.invalid', ...Object.fromEntries(Object.entries(row.values).filter(([key]) => key !== 'fqdn').map(([key, value]) => [key, valid[value.answer]]))})[key]);
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
// answerable in every program whose rows name it, and the credential pair of the install-branch
// conditions has to name an answer the program declares.
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

function assertCredentialPair(conditions, program) {
  for (const name of branchConditions) {
    const {credential_answer: answer, credential_user: user} = conditions[name];
    assert.equal(answer === undefined, user === undefined, `${name} names one of credential_answer and credential_user and not the other`);
    assert.equal(answer, 'platform_repo_read_pat', name);
    assert.equal(user, 'oauth2', name);
    assert.ok(program.answers.some(declared => declared.name === answer), `${name} reads ${answer}, and ${program.name} does not declare it`);
  }
}

test('the platform conditions are answerable in every program that names them', () => {
  assertConditionsAnswerable(installation.conditions, [hostProgram, branch]);
});

test('PLANTED DEFECT: a condition over an answer the program does not declare, and a pair half given, are refused', () => {
  const undeclared = structuredClone(hostProgram);
  undeclared.answers = undeclared.answers.filter(answer => answer.name !== 'forgejo_platform_repository');
  assert.throws(() => assertConditionsAnswerable(installation.conditions, [undeclared, branch]), /does not declare forgejo_platform_repository/);
  const unnamed = structuredClone(installation.conditions);
  delete unnamed.platform_on_github_in_answers;
  assert.throws(() => assertConditionsAnswerable(unnamed, [hostProgram, branch]));
  const half = structuredClone(installation.conditions);
  delete half.install_branch_published.credential_user;
  assert.throws(() => assertCredentialPair(half, branch), /names one of credential_answer and credential_user/);
  const unknown = structuredClone(installation.conditions);
  unknown.install_branch_unpublished.credential_answer = 'platform_repo_pat';
  assert.throws(() => assertCredentialPair(unknown, branch));
  const unread = structuredClone(branch);
  unread.answers = unread.answers.filter(answer => answer.name !== 'platform_repo_read_pat');
  assert.throws(() => assertCredentialPair(installation.conditions, unread), /does not declare it/);
});

test('PLANTED INNOCENT: the conditions as they stand, with a reworded description, stay accepted', () => {
  const reworded = structuredClone(hostProgram);
  reworded.answers.find(answer => answer.name === 'forgejo_host').describes += ' Reworded.';
  assertConditionsAnswerable(installation.conditions, [reworded, branch]);
  assertCredentialPair(installation.conditions, branch);
});
