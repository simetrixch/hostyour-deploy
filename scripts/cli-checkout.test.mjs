import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// scripts/test.sh runs the registry binding suite in an ansiwise-cli tree that scripts/cli-checkout.sh names. On the
// master's ci that tree is the commit ci-sources.json pins, taken with `git archive` out of the read-only bare
// repository the fetch task made of it (CI_SOURCES_DIR); a worktree would write into that repository, and a branch head
// is not what the pin says. On a machine it is the checkout beside the main one, found by name without case.
const SCRIPT = fileURLToPath(new URL('./cli-checkout.sh', import.meta.url));
const SUITE = 'test/checks/config_validity_test.dart';
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'init.defaultBranch=master', ...args], {cwd, encoding: 'utf8'}).trim();
const roots = [];
const sandbox = () => { const root = mkdtempSync(join(tmpdir(), 'cli-checkout-')); roots.push(root); return root; };
test.after(() => { for (const root of roots) { execFileSync('chmod', ['-R', 'u+w', root]); rmSync(root, {recursive: true, force: true}); } });

/** A deploy tree holding only the script (and the pins file, when given), as the script finds its root from its own place. */
function deployTree(root, pins) {
  const tree = join(root, 'deploy');
  mkdirSync(join(tree, 'scripts'), {recursive: true});
  copyFileSync(SCRIPT, join(tree, 'scripts/cli-checkout.sh'));
  if (pins !== undefined) writeFileSync(join(tree, 'ci-sources.json'), JSON.stringify(pins));
  return tree;
}
const run = (tree, env) => spawnSync('bash', [join(tree, 'scripts/cli-checkout.sh'), SUITE], {encoding: 'utf8', env: {PATH: process.env.PATH, HOME: process.env.HOME, ...env}});

/** An ansiwise-cli source with two commits, and the bare repository a master's ci makes of the first one. */
function ciSources(root, {withSuite = true} = {}) {
  const source = join(root, 'cli');
  mkdirSync(join(source, 'test/checks'), {recursive: true});
  writeFileSync(join(source, withSuite ? SUITE : 'test/checks/other_test.dart'), 'pinned\n');
  git(source, 'init', '-q'); git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'pinned');
  const pinned = git(source, 'rev-parse', 'HEAD');
  writeFileSync(join(source, 'test/checks/later.dart'), 'later\n'); writeFileSync(join(source, withSuite ? SUITE : 'test/checks/other_test.dart'), 'moved on\n');
  git(source, 'add', '-A'); git(source, 'commit', '-q', '-m', 'moved on');
  const sources = join(root, 'sources');
  mkdirSync(sources);
  git(root, 'init', '-q', '--bare', join(sources, 'ansiwise-cli.git'));
  git(root, `--git-dir=${join(sources, 'ansiwise-cli.git')}`, 'fetch', '-q', '--depth=1', `file://${source}`, pinned);
  return {sources, pinned, head: git(source, 'rev-parse', 'HEAD')};
}

test('on the master\'s ci the suite runs in the pinned commit of ansiwise-cli, read from a read-only repository by git archive', () => {
  const root = sandbox();
  const {sources, pinned} = ciSources(root);
  const tree = deployTree(root, {git: {'ansiwise-cli': pinned}});
  execFileSync('chmod', ['-R', 'a-w', sources]);
  const result = run(tree, {CI_SOURCES_DIR: sources});
  assert.equal(result.status, 0, result.stderr);
  const cli = result.stdout.trim();
  assert.equal(readFileSync(join(cli, SUITE), 'utf8'), 'pinned\n', 'PLANTED INNOCENT: the pinned commit, though the source has moved on');
  assert.equal(existsSync(join(cli, 'test/checks/later.dart')), false, 'a file the pinned commit lacks stays out');
  assert.equal(existsSync(join(cli, '.git')), false, 'a tree and no worktree');
  rmSync(cli, {recursive: true, force: true});
});

test('a pin that is no full commit, a missing pin, a commit the repository lacks and a tree without the suite each stop the run and say which', () => {
  const root = sandbox();
  const {sources, pinned, head} = ciSources(root);
  for (const [pins, why] of [
    [{git: {'ansiwise-cli': 'master'}}, /ci-sources\.json pins ansiwise-cli at 'master'/],
    [{git: {'ansiwise-cli': pinned.slice(0, 12)}}, /ci-sources\.json pins ansiwise-cli at/],
    [{git: {'ansiwise-cli': pinned.toUpperCase()}}, /ci-sources\.json pins ansiwise-cli at/],
    [{git: {}}, /ci-sources\.json pins ansiwise-cli at ''/],
    [{git: {'ansiwise-cli': head}}, /ansiwise-cli at [0-9a-f]{40} could not be read/],
  ]) {
    const result = run(deployTree(sandbox(), pins), {CI_SOURCES_DIR: sources});
    assert.notEqual(result.status, 0, `PLANTED DEFECT: ${JSON.stringify(pins)} is refused`);
    assert.match(result.stderr, why);
    assert.equal(result.stdout, '', 'and names no tree to run in');
  }
  const bare = sandbox();
  const without = ciSources(bare, {withSuite: false});
  const noSuite = run(deployTree(sandbox(), {git: {'ansiwise-cli': without.pinned}}), {CI_SOURCES_DIR: without.sources});
  assert.notEqual(noSuite.status, 0, 'PLANTED DEFECT: a pinned tree without the binding suite is refused');
  assert.match(noSuite.stderr, new RegExp(SUITE));
});

test('on a machine the suite runs in the ansiwise-cli checkout beside the main checkout, found by name without case', () => {
  const root = sandbox();
  const main = join(root, 'hostyour-deploy');
  mkdirSync(join(main, 'scripts'), {recursive: true});
  copyFileSync(SCRIPT, join(main, 'scripts/cli-checkout.sh'));
  git(main, 'init', '-q');
  mkdirSync(join(root, 'Ansiwise-CLI/test/checks'), {recursive: true});
  writeFileSync(join(root, 'Ansiwise-CLI', SUITE), 'beside\n');
  const found = run(main, {});
  assert.equal(found.status, 0, found.stderr);
  assert.equal(found.stdout.trim(), join(root, 'Ansiwise-CLI'), 'PLANTED INNOCENT: a differently cased checkout is found');
  rmSync(join(root, 'Ansiwise-CLI'), {recursive: true});
  const missing = run(main, {});
  assert.notEqual(missing.status, 0, 'PLANTED DEFECT: no checkout beside it is refused');
  assert.match(missing.stderr, /no ansiwise-cli checkout beside/);
  mkdirSync(join(root, 'ansiwise-cli'));
  const bare = run(main, {});
  assert.notEqual(bare.status, 0, 'a checkout without the suite is refused');
  assert.match(bare.stderr, new RegExp(SUITE));
  chmodSync(root, 0o755);
});
