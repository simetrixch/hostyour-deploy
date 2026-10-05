import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// A machine whose system disk is full of images nothing runs prunes them before the free-disk check,
// at that check's own path and floor, so a redeploy is refused only for space the cluster really holds.
const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-host.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every way deploy-host misses pruning before its free-disk check. */
function findings(steps) {
  const prune = steps.findIndex(row => row.step === 'prune_unused_images');
  const check = steps.findIndex(row => row.step === 'require_free_disk');
  if (prune < 0) return ['nothing prunes the unused images'];
  if (check < 0) return ['no free-disk check to stand before'];
  const [p, c] = [steps[prune], steps[check]];
  const found = [];
  if (prune > check) found.push('the prune stands after the check');
  if (p.path !== c.path) found.push(`the prune measures ${p.path}, the check ${c.path}`);
  if (p.free_kibibytes !== c.free_kibibytes) found.push(`the prune's floor ${p.free_kibibytes} is not the check's ${c.free_kibibytes}`);
  if (JSON.stringify(p.prune_command) !== JSON.stringify(['microk8s', 'ctr', '--namespace', 'k8s.io', 'images', 'prune', '--all'])) found.push(`prunes with ${p.prune_command}`);
  if (p.elevated !== true) found.push('runs the runtime unelevated, which its socket refuses');
  if (p.when !== undefined) found.push('only on some machines');
  // The dry run cannot see the prune's effect, so the check must rest on the prune or the dry run
  // refuses what the real run would free (ansiwise-core step_execution.dart: declared in dry and plan).
  if (c.rests_on_an_earlier_step !== true) found.push('the free-disk check does not rest on the prune, so the dry run measures the disk before it is pruned');
  return found;
}

test('deploy-host prunes unused images before its free-disk check, at the same path and floor', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: each way out is found, and the program itself is not', () => {
  const at = (rows, step) => rows.findIndex(row => row.step === step);
  const planted = {
    'no prune': rows => { rows.splice(at(rows, 'prune_unused_images'), 1); },
    'after the check': rows => { const [row] = rows.splice(at(rows, 'prune_unused_images'), 1); rows.push(row); },
    'another floor': rows => { rows[at(rows, 'prune_unused_images')].free_kibibytes = 1000000; },
    'another path': rows => { rows[at(rows, 'prune_unused_images')].path = '/var'; },
    'all images, not the unused': rows => { rows[at(rows, 'prune_unused_images')].prune_command = ['microk8s', 'ctr', '--namespace', 'k8s.io', 'images', 'rm']; },
    'unelevated': rows => { rows[at(rows, 'prune_unused_images')].elevated = false; },
    'the check measured in the dry run': rows => { delete rows[at(rows, 'require_free_disk')].rests_on_an_earlier_step; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});
