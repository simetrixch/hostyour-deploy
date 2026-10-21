import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const program = JSON.parse(execFileSync('yq', ['-o=json', '.', join(root, 'ansiwise/programs/deploy-branch.yaml')], {encoding: 'utf8'}));
const managerAnswer = 'build_manager_repo_write_pat';
const managerKey = 'BUILD_HOSTYOUR_MANAGER_REPO_PAT';
const cloudKey = 'BUILD_HOSTYOUR_CLOUD_REPO_PAT';
const row = program.steps.find(step => step.step === 'fill_key_value_file' && Object.hasOwn(step.values, cloudKey));
const appRow = program.steps.find(step => step.step === 'fill_key_value_file' && Object.hasOwn(step.values, 'GITHUB_APP_ID'));

function run(row) {
  const dir = mkdtempSync(join(tmpdir(), 'deploy-branch-secrets-'));
  const pat = randomBytes(24).toString('hex');
  const cloudPat = randomBytes(24).toString('hex');
  try {
    const step = structuredClone(row);
    step.template_path = join(dir, 'secrets.example');
    step.path = join(dir, 'secrets.<stage>');
    // A legacy template must not let a restored writer escape the generated-file assertion.
    writeFileSync(step.template_path, [...new Set([...Object.keys(step.values), managerKey])].map(key => `${key}=\n`).join(''));
    const names = [...new Set([...Object.values(step.values).map(value => value.answer), managerAnswer])];
    const controlled = {
      name: program.name,
      roles: program.roles,
      answers: [{name: 'stage', kind: 'text', required: true, describes: 'The fixture stage.'},
        ...names.map(name => ({name, kind: 'text', required: true, secret: true, describes: 'A synthetic fixture credential.'}))],
      steps: [step],
    };
    mkdirSync(join(dir, 'programs'));
    writeFileSync(join(dir, 'programs/deploy-branch.yaml'), JSON.stringify(controlled));
    const answers = {stage: 'prod', ...Object.fromEntries(names.map(name => [name, `fixture_${name}`])),
      [managerAnswer]: pat, ...(names.includes('build_platform_repo_write_pat') ? {build_platform_repo_write_pat: cloudPat} : {})};
    const binary = process.env.ANSIWISE_BIN;
    const cli = process.env.ANSIWISE_CLI_CHECKOUT;
    assert.ok(binary || cli, 'set ANSIWISE_BIN or ANSIWISE_CLI_CHECKOUT; the file-writing regression must run, never skip');
    for (const mode of ['test', 'dry', 'run']) {
      const args = [controlled.name, '--mode', mode, '--config', join(root, 'ansiwise.yaml'),
        '--programs', join(dir, 'programs'), '--runs', join(dir, 'runs'), '--answers', '-', '--without-elevation-password'];
      const result = spawnSync(binary || 'dart', binary ? args : ['run', 'bin/ansiwise.dart', ...args], {
        cwd: binary ? dir : cli, input: JSON.stringify({answers}), encoding: 'utf8', timeout: 30_000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
    }
    const generated = readFileSync(join(dir, 'secrets.prod'), 'utf8');
    return {hasManagerPat: generated.includes(pat), hasCloudPat: generated.includes(cloudPat), generated};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

function assertNoManagerPat(result) {
  assert.equal(result.hasManagerPat, false, 'the generated secrets file retains the Manager PAT');
}

test('deploy-branch no longer asks for the Manager access-probe PAT', () => {
  assert.equal(program.answers.some(answer => answer.name === managerAnswer), false);
});

test('a synthetic Manager PAT is absent from the generated secrets file', () => {
  assertNoManagerPat(run(row));
});

test('PLANTED DEFECT: restoring the Manager PAT writer fails the generated-file assertion', () => {
  const changed = structuredClone(row);
  changed.values[managerKey] = {answer: managerAnswer};
  assert.throws(() => assertNoManagerPat(run(changed)), /the generated secrets file retains the Manager PAT/);
});

test('PLANTED INNOCENT: the cloud bump PAT still reaches the generated secrets file', () => {
  assert.equal(run(row).hasCloudPat, true);
});

// THE GITHUB APP'S CREDENTIAL IS FOUR VALUES, and the owner is one of them: Argo CD's repository
// credential on this installation matches the repository by a prefix, and the prefix is the owner the
// App is installed for, which no address of the installation gives.
const appKeys = {GITHUB_APP_ID: 'github_app_id', GITHUB_APP_INSTALLATION_ID: 'github_app_installation_id',
  GITHUB_APP_PRIVATE_KEY: 'github_app_private_key', GITHUB_APP_OWNER: 'github_app_owner'};

function assertAppCredential(result) {
  for (const [key, answer] of Object.entries(appKeys)) {
    assert.ok(result.generated.includes(`${key}="fixture_${answer}"`), `the generated secrets file does not carry ${key}`);
  }
}

test('the generated secrets file carries the App id, the installation, the key and the owner', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(appRow.values).filter(([key]) => key in appKeys).map(([key, value]) => [key, value.answer])), appKeys);
  assert.equal(program.answers.find(answer => answer.name === 'github_app_owner')?.required, true);
  assertAppCredential(run(appRow));
});

test('PLANTED DEFECT: three App values without the owner fail the generated-file assertion', () => {
  const changed = structuredClone(appRow);
  delete changed.values.GITHUB_APP_OWNER;
  assert.throws(() => assertAppCredential(run(changed)), /does not carry GITHUB_APP_OWNER/);
});
