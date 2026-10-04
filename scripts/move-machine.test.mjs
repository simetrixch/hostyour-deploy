import {strict as assert} from 'node:assert';
import {spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function pair(args) {
  const bash = spawnSync('bash', [root + 'scripts/move-machine.sh', ...args]);
  const ps = spawnSync('pwsh', ['-NoProfile', '-File', root + 'scripts/move-machine.ps1', ...args]);
  assert.equal(bash.error, undefined); assert.equal(ps.error, undefined);
  assert.equal(ps.status, bash.status);
  assert.deepEqual(ps.stdout, bash.stdout);
  assert.deepEqual(ps.stderr, bash.stderr);
  return bash;
}

test('both launchers expose the same usage and reject missing/shared dependency input', () => {
  assert.equal(pair(['--help']).status, 0);
  assert.equal(pair(['--dry-run']).status, 64);
  assert.equal(pair(['--cloud-dir']).status, 64);
  assert.equal(pair(['--cloud-dir', '/missing/cloud', '--dry-run']).status, 66);
});

test('forward every argument unchanged, require a machine, propagate shared planner failure', () => {
  const cloud = mkdtempSync(join(tmpdir(), 'domain planner '));
  try {
    mkdirSync(join(cloud, 'lifecycle'));
    // This probe checks transport only; the real planner is covered by Cloud CI and live dry runs.
    writeFileSync(join(cloud, 'lifecycle/plan-installation-domain.mjs'),
      'export async function runDomainPlan(args, repo, machine) { process.stdout.write(JSON.stringify({args, repo, machine}) + "\\n"); process.stderr.write("probe: rejected\\n"); process.exitCode = 69; }\n');
    const args = ['--books-fqdn', 'master.old.example', '--from-domain', 'old.example', '--to-domain', 'new.example',
      '--fqdn', 'apps1.old.example', '--ssh-user', 'operator', '--dry-run'];
    const result = pair(['--cloud-dir', cloud, ...args]);
    assert.equal(result.status, 69);
    assert.deepEqual(JSON.parse(result.stdout), {args, repo: cloud, machine: true});
    assert.equal(result.stderr.toString(), 'probe: rejected\n');
  } finally { rmSync(cloud, {recursive: true, force: true}); }
});
