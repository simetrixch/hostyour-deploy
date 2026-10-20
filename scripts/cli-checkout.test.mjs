import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// scripts/test.sh runs the registry binding suite in an ansiwise-cli tree that scripts/cli-checkout.sh names: the commit
// ci-sources.json pins, taken with `git archive` out of the ansiwise-cli checkout beside the main one, found by name
// without case. What that checkout stands on is not what the pin says.
const SCRIPT = fileURLToPath(new URL('./cli-checkout.sh', import.meta.url));
const SUITE = 'test/checks/config_validity_test.dart';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=master', ...args], {cwd, encoding: 'utf8'}).trim();
const roots = [];
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'cli-checkout-')); roots.push(root); return root; };
test.after(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });

/** A main deploy checkout holding only the script and the pins file, and an ansiwise-cli checkout beside it, cased
 * differently, whose head has moved on from the commit it is pinned at. */
function machine({withSuite = true} = {}) {
  const root = sandbox();
  const cli = join(root, 'Ansiwise-CLI');
  const suite = withSuite ? SUITE : 'test/checks/other_test.dart';
  mkdirSync(join(cli, 'test/checks'), {recursive: true});
  writeFileSync(join(cli, suite), 'pinned\n');
  git(cli, 'init', '-q'); git(cli, 'add', '-A'); git(cli, 'commit', '-q', '-m', 'pinned');
  const pinned = git(cli, 'rev-parse', 'HEAD');
  writeFileSync(join(cli, 'test/checks/later.dart'), 'later\n'); writeFileSync(join(cli, suite), 'moved on\n');
  git(cli, 'add', '-A'); git(cli, 'commit', '-q', '-m', 'moved on');
  const main = join(root, 'hostyour-deploy');
  mkdirSync(join(main, 'scripts'), {recursive: true});
  copyFileSync(SCRIPT, join(main, 'scripts/cli-checkout.sh'));
  git(main, 'init', '-q');
  const pin = (pins) => writeFileSync(join(main, 'ci-sources.json'), JSON.stringify(pins));
  pin({git: {'ansiwise-cli': pinned}});
  return {root, cli, main, pinned, pin};
}
const run = (tree) => spawnSync('bash', [join(tree, 'scripts/cli-checkout.sh'), SUITE], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.HOME}});

test('the suite runs in the pinned commit of the ansiwise-cli checkout beside the main one, whatever that checkout stands on', () => {
  const {cli, main} = machine();
  const result = run(main);
  assert.equal(result.status, 0, result.stderr);
  const tree = result.stdout.trim();
  assert.notEqual(tree, cli, 'a new directory, never the checkout itself');
  assert.equal(readFileSync(join(tree, SUITE), 'utf8'), 'pinned\n', 'PLANTED DEFECT: the checkout beside stands on a later commit, and the tree is still the pin');
  assert.equal(existsSync(join(tree, 'test/checks/later.dart')), false, 'a file the pinned commit lacks stays out');
  assert.equal(existsSync(join(tree, '.git')), false, 'a tree and no worktree');
  assert.equal(readFileSync(join(cli, SUITE), 'utf8'), 'moved on\n', 'PLANTED INNOCENT: the differently cased checkout is found and left as it stands');
  rmSync(tree, {recursive: true, force: true});
});

test('the suite runs in the pinned commit from a worktree too, whose parent holds no CLI checkout', () => {
  const {root, main} = machine();
  git(main, 'commit', '-q', '--allow-empty', '-m', 'base');
  const worktree = join(root, '.worktrees/hostyour-deploy/issue-1');
  git(main, 'worktree', 'add', '-q', worktree);
  mkdirSync(join(worktree, 'scripts'));
  copyFileSync(SCRIPT, join(worktree, 'scripts/cli-checkout.sh'));
  copyFileSync(join(main, 'ci-sources.json'), join(worktree, 'ci-sources.json'));
  const result = run(worktree);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(result.stdout.trim(), SUITE), 'utf8'), 'pinned\n');
  rmSync(result.stdout.trim(), {recursive: true, force: true});
});

test('a pin that is no full commit, a missing pin, a commit the checkout lacks, no checkout and a tree without the suite each stop the run and say which', () => {
  const {cli, main, pinned, pin} = machine();
  for (const [pins, why] of [
    [{git: {'ansiwise-cli': 'master'}}, /ci-sources\.json pins ansiwise-cli at 'master'/],
    [{git: {'ansiwise-cli': pinned.slice(0, 12)}}, /ci-sources\.json pins ansiwise-cli at/],
    [{git: {'ansiwise-cli': pinned.toUpperCase()}}, /ci-sources\.json pins ansiwise-cli at/],
    [{git: {}}, /ci-sources\.json pins ansiwise-cli at ''/],
    [{git: {'ansiwise-cli': 'f'.repeat(40)}}, /lacks ansiwise-cli at f{40}, the commit ci-sources\.json pins; fetch it there/],
  ]) {
    pin(pins);
    const result = run(main);
    assert.notEqual(result.status, 0, `PLANTED DEFECT: ${JSON.stringify(pins)} is refused`);
    assert.match(result.stderr, why);
    assert.equal(result.stdout, '', 'and names no tree to run in');
  }
  pin({git: {'ansiwise-cli': pinned}});
  rmSync(cli, {recursive: true});
  const missing = run(main);
  assert.notEqual(missing.status, 0, 'PLANTED DEFECT: no checkout beside it is refused');
  assert.match(missing.stderr, /no ansiwise-cli checkout beside/);
  const without = machine({withSuite: false});
  const noSuite = run(without.main);
  assert.notEqual(noSuite.status, 0, 'PLANTED DEFECT: a pinned tree without the binding suite is refused');
  assert.match(noSuite.stderr, new RegExp(SUITE));
});
