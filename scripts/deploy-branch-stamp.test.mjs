import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {ansiwiseRun} from './ansiwise-run.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const program = JSON.parse(execFileSync('yq', ['-o=json', '.', join(root, 'ansiwise/programs/deploy-branch.yaml')], {encoding: 'utf8'}));

// A stamp rewrites files in the checkout on the machine, and only a later git_commit row of the same
// repository records them. A file stamped outside that commit's paths stays uncommitted, and the next
// regeneration refuses the dirty checkout, so every platform release stops there.
function assertStampsCommitted(steps) {
  const stamps = steps.filter(step => step.step === 'stamp_placeholder_in_tracked_files');
  assert.notEqual(stamps.length, 0, 'deploy-branch holds no stamp_placeholder_in_tracked_files row to check');
  for (const stamp of stamps) {
    const at = steps.indexOf(stamp);
    const committed = steps.slice(at + 1)
      .filter(step => step.step === 'git_commit' && step.repository === stamp.repository)
      .flatMap(step => step.paths ?? []);
    const tree = stamp.tree ?? program.defaults?.tree;
    const name = `the stamp row of ${stamp.placeholder} in ${stamp.repository} (step ${at + 1})`;
    assert.ok(tree, `${name} names no tree, so it stamps files outside what a later git_commit carries: ${committed.join(', ')}`);
    assert.ok(committed.some(path => tree === path || tree.startsWith(`${path}/`)),
      `${name} stamps ${tree}, which no later git_commit of ${stamp.repository} carries: ${committed.join(', ')}`);
  }
}

function withStamp(change) {
  const steps = structuredClone(program.steps);
  change(steps.find(step => step.step === 'stamp_placeholder_in_tracked_files'), steps);
  return steps;
}

test('every stamp of deploy-branch reaches only what a later git_commit carries', () => {
  assertStampsCommitted(program.steps);
});

test('PLANTED DEFECT: a stamp row with no tree stamps the whole checkout', () => {
  const steps = withStamp(stamp => { delete stamp.tree; });
  assert.throws(() => assertStampsCommitted(steps), /stamp row of example\.invalid .* names no tree/);
});

test('PLANTED DEFECT: a stamp row on lifecycle stamps what no commit carries', () => {
  const steps = withStamp(stamp => { stamp.tree = 'lifecycle'; });
  assert.throws(() => assertStampsCommitted(steps), /stamp row of example\.invalid .* stamps lifecycle, which no later git_commit/);
});

test('PLANTED DEFECT: a git_commit before the stamp leaves the stamp uncommitted', () => {
  const steps = withStamp((stamp, all) => {
    stamp.tree = 'clusters';
    const commit = all.findIndex(step => step.step === 'git_commit' && step.repository === stamp.repository);
    all.splice(all.indexOf(stamp), 0, ...all.splice(commit, 1));
  });
  assert.throws(() => assertStampsCommitted(steps), /stamps clusters, which no later git_commit/);
});

test('PLANTED INNOCENT: a stamp row on clusters stays green', () => {
  assertStampsCommitted(withStamp(stamp => { stamp.tree = 'clusters'; }));
});

function assertRepositoryCredentialsCommitted(steps) {
  const at = steps.findIndex(s => s.path === '/srv/hostyour-cloud/installation/values/repository-credentials.yaml');
  assert.ok(at >= 0, 'repository credentials are not written');
  assert.ok(steps.slice(at + 1).some(s => s.step === 'git_commit' && s.repository === '/srv/hostyour-cloud' && s.paths?.includes('installation')), 'repository credentials are not committed');
}

test('repository credentials are written before the installation commit, with red and innocent probes', () => {
  assertRepositoryCredentialsCommitted(program.steps);
  const missing = structuredClone(program.steps);
  missing.splice(missing.findIndex(s => s.path?.endsWith('/repository-credentials.yaml')), 1);
  assert.throws(() => assertRepositoryCredentialsCommitted(missing));
  const uncommitted = structuredClone(program.steps);
  uncommitted.find(s => s.step === 'git_commit').paths = ['clusters', 'configs'];
  assert.throws(() => assertRepositoryCredentialsCommitted(uncommitted));
  assertRepositoryCredentialsCommitted([...program.steps]);
});

// THE ROOT APPLICATION'S ADDRESS is stamped from the same pair of answers that chooses deploy-host's
// clone: the Forgejo host and repository where `platform_repo` and `forgejo_platform_repository` name
// the same repository, `platform_repo` on github.com where they do not.
const rootApplication = 'clusters/argocd/root-app.yaml';
const addressStamps = steps => steps.filter(step => step.step === 'stamp_placeholder_in_tracked_files' && step.tree === rootApplication);
const wording = stamp => [stamp.placeholder, stamp.value_answer];

function assertRootApplicationAddress(steps, answers) {
  const forgejo = addressStamps(steps).filter(stamp => stamp.when?.length === 1 && stamp.when[0] === 'platform_on_forgejo_in_answers');
  const github = addressStamps(steps).filter(stamp => stamp.when?.length === 1 && stamp.when[0] === 'platform_on_github_in_answers');
  assert.equal(addressStamps(steps).length, forgejo.length + github.length, 'a stamp of the root Application is chosen by neither condition, or by both');
  assert.deepEqual(forgejo.map(wording), [['github.com', 'forgejo_host'], ['simetrixch/hostyour-cloud', 'forgejo_platform_repository']]);
  assert.deepEqual(github.map(wording), [['simetrixch/hostyour-cloud', 'platform_repo']]);
  for (const stamp of addressStamps(steps)) {
    assert.equal(stamp.on_failure, 'exit');
    assert.equal(stamp.repository, '/srv/hostyour-cloud');
    assert.ok(answers.some(answer => answer.name === stamp.value_answer), `${stamp.value_answer} is not declared`);
  }
}

test('the root Application address is stamped in a Forgejo form and a GitHub form, each chosen by a condition', () => {
  assertRootApplicationAddress(program.steps, program.answers);
  assertStampsCommitted(program.steps);
});

test('PLANTED DEFECTS: a stamp that keeps github.com on the Forgejo answers, and the other ways the forms fall apart, are refused', () => {
  const planted = [
    ['the Forgejo form keeps github.com', steps => steps.splice(steps.indexOf(addressStamps(steps)[0]), 1)],
    ['the Forgejo form stamps the GitHub repository answer', steps => { addressStamps(steps)[1].value_answer = 'platform_repo'; }],
    ['the GitHub form is chosen by the Forgejo condition', steps => { addressStamps(steps)[2].when = ['platform_on_forgejo_in_answers']; }],
    ['a stamp is chosen by no condition', steps => { delete addressStamps(steps)[0].when; }],
    ['the GitHub form is missing', steps => steps.splice(steps.indexOf(addressStamps(steps)[2]), 1)],
  ];
  for (const [name, change] of planted) {
    const steps = structuredClone(program.steps); change(steps);
    assert.throws(() => assertRootApplicationAddress(steps, program.answers), undefined, name);
  }
  const undeclared = program.answers.filter(answer => answer.name !== 'forgejo_host');
  assert.throws(() => assertRootApplicationAddress(program.steps, undeclared), /forgejo_host is not declared/);
  const unused = structuredClone(program.steps);
  addressStamps(unused)[0].tree = 'clusters';
  assert.throws(() => assertRootApplicationAddress(unused, program.answers));
  assertRootApplicationAddress(structuredClone(program.steps), program.answers);
});

// THE REAL CLI STAMPS THE ADDRESS. The tree carries one line with the github.com address, as the
// product tree's root-app.yaml does, and the three rows run on a checkout standing on an installation's
// branch: the forms are chosen by the answers, the Forgejo form rewrites both literals of the address,
// and a second run finds nothing to do.
const trunkLine = '    - repoURL: &repo "https://github.com/simetrixch/hostyour-cloud.git"';
const trunkFile = ['spec:', '  sources:', trunkLine, '      targetRevision: &branch example.invalid', '    - repoURL: *repo', ''].join('\n');
const stampedTrunk = trunkFile.replace('example.invalid', 'installation.example.org');

const stampRows = program.steps.filter(step => step.step === 'stamp_placeholder_in_tracked_files');

function stampedFile(answers, {runs = 1, rows = stampRows} = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'root-app-stamp-'));
  try {
    const git = (...args) => execFileSync('git', ['-C', dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', ...args], {encoding: 'utf8'});
    git('init', '-q', '-b', 'master');
    mkdirSync(join(dir, 'clusters/argocd'), {recursive: true});
    writeFileSync(join(dir, rootApplication), trunkFile);
    git('add', '-A'); git('commit', '-q', '-m', 'trunk'); git('switch', '-q', '-c', 'installation.example.org');
    const definition = {
      name: 'deploy-branch', roles: ['master'], defaults: program.defaults,
      answers: program.answers.filter(answer => ['platform_repo', 'forgejo_platform_repository', 'forgejo_host', 'fqdn'].includes(answer.name)),
      steps: rows.map(row => ({...row, repository: dir})),
    };
    for (let time = 0; time < runs; time += 1) {
      const result = ansiwiseRun({definition, config: join(root, 'ansiwise.yaml'), modes: ['dry', 'run'], answers});
      assert.equal(result.code, 0, `${result.mode}: ${result.output}`);
    }
    return readFileSync(join(dir, rootApplication), 'utf8');
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

const stampAnswers = {fqdn: 'installation.example.org', forgejo_host: 'forgejo.example.org', forgejo_platform_repository: 'forge-org/platform'};

test('REAL CLI: the Forgejo answers point the root Application at Forgejo, today\'s answers keep github.com, and a second run changes nothing', () => {
  const forgejo = stampedFile({...stampAnswers, platform_repo: 'forge-org/platform'}, {runs: 2});
  assert.ok(forgejo.includes('    - repoURL: &repo "https://forgejo.example.org/forge-org/platform.git"'), forgejo);
  assert.ok(!forgejo.includes('github.com'), 'the Forgejo form keeps github.com');
  assert.ok(forgejo.includes('    - repoURL: *repo'), 'the alias of the address was rewritten');
  const github = stampedFile({...stampAnswers, platform_repo: 'simetrixch/hostyour-cloud'});
  assert.equal(github, stampedTrunk);
  const elsewhere = stampedFile({...stampAnswers, platform_repo: 'someone/platform'});
  assert.ok(elsewhere.includes('"https://github.com/someone/platform.git"'), elsewhere);
});

test('PLANTED DEFECT, REAL CLI: a Forgejo form without the host row keeps github.com on the Forgejo answers', () => {
  const hostRowMissing = stampRows.filter(stamp => stamp.value_answer !== 'forgejo_host');
  const stamped = stampedFile({...stampAnswers, platform_repo: 'forge-org/platform'}, {rows: hostRowMissing});
  assert.throws(() => assert.ok(!stamped.includes('github.com'), 'the Forgejo form keeps github.com'), /keeps github.com/);
});

// THE MANAGER IS TOLD THE MAILBOX THE INSTALLATION WAS SET UP WITH. The generated manager.yaml carries the
// committer_email answer as `installationCommitterEmail`, the key the Manager reads as
// INSTALLATION_COMMITTER_EMAIL; a row that binds another answer, or a template that drops the key, leaves the
// Manager without the mailbox a placement commits under.
const managerValuesRow = steps => steps.find(step => step.path === '/srv/hostyour-cloud/installation/values/manager.yaml');

function renderedManagerValues(steps, values = {'operator-user': 'operator', 'lan-host': '10.0.0.5', 'programs-repo': 'org/programs', 'committer-email': 'installation@example.invalid'}) {
  const row = managerValuesRow(steps);
  assert.ok(row, 'manager.yaml is not written');
  const template = readFileSync(join(root, row.template), 'utf8');
  const bound = Object.fromEntries(Object.entries(row.values).map(([key, binding]) => [key, values[binding.answer === 'committer_email' ? 'committer-email' : key]]));
  const dir = mkdtempSync(join(tmpdir(), 'manager-values-'));
  try {
    const path = join(dir, 'manager.yaml');
    writeFileSync(path, template.replace(/<([a-z][a-z0-9-]*)>/g, (_, key) => bound[key] ?? `<${key}>`));
    return JSON.parse(execFileSync('yq', ['-o=json', '.', path], {encoding: 'utf8'}));
  } finally { rmSync(dir, {recursive: true, force: true}); }
}

function assertMailboxCarried(steps) {
  const bound = managerValuesRow(steps).values['committer-email']?.answer;
  assert.equal(bound, 'committer_email', 'the manager values bind another answer than committer_email');
  assert.equal(renderedManagerValues(steps).installationCommitterEmail, 'installation@example.invalid', 'the manager values do not carry the mailbox');
}

test('the generated manager values carry the committer_email answer as installationCommitterEmail', () => {
  assertMailboxCarried(program.steps);
  assert.equal(renderedManagerValues(program.steps).master.sshUser, 'operator');
  assert.equal(renderedManagerValues(program.steps).github.programsRepo, 'org/programs');
});

test('PLANTED DEFECTS: another answer bound to the mailbox, and a mailbox left unbound, are refused', () => {
  const rebound = structuredClone(program.steps);
  managerValuesRow(rebound).values['committer-email'] = {answer: 'operator_user'};
  assert.throws(() => assertMailboxCarried(rebound), /bind another answer/);
  const unbound = structuredClone(program.steps);
  delete managerValuesRow(unbound).values['committer-email'];
  assert.throws(() => assertMailboxCarried(unbound), /bind another answer/);
  assertMailboxCarried(structuredClone(program.steps));
});
