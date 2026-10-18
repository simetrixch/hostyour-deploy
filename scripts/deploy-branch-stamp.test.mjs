import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

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
