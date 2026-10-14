import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The key Forgejo signs its webhook deliveries with. One row mints it into an entry of its own,
// <stage>/app/forgejo-webhook, where the build plane is: hostyour-cloud's image-builder reads that
// entry with a policy that makes a missing ENTRY no error and a missing FIELD of an entry that exists
// one, so the key must not join GitHub's entry, <stage>/app/image-builder, whose row stays as it was.
const LEAF = '<stage>/app/forgejo-webhook';
const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-platform-services.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every way the program breaks the rule, named. */
function findings(steps) {
  const found = [];
  const rows = steps.filter(step => step.step === 'vault_kv_entry' && step.path === LEAF);
  if (rows.length !== 1) return [`${rows.length} rows write ${LEAF}, not 1`];
  const [row] = rows;
  if (JSON.stringify(row.fields) !== JSON.stringify(['forgejo-webhook-secret=FORGEJO_WEBHOOK_SECRET']) || JSON.stringify(row.mint) !== JSON.stringify(['forgejo-webhook-secret'])) found.push(`${LEAF} does not mint forgejo-webhook-secret alone`);
  if (!(row.when ?? []).includes('build_plane_here_in_answers')) found.push(`${LEAF} is written where no build plane runs`);
  const github = steps.filter(step => step.step === 'vault_kv_entry' && step.path === '<stage>/app/image-builder');
  if (github.length !== 1 || JSON.stringify(github[0].mint) !== JSON.stringify(['github-webhook-secret'])) found.push('the GitHub entry no longer holds github-webhook-secret alone');
  return found;
}

test('one row mints the Forgejo webhook key into an entry of its own', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: the key beside GitHub\'s, a second row, or no build-plane condition are found', () => {
  const planted = {
    'the key joins the GitHub entry': steps => { const g = steps.find(s => s.path === '<stage>/app/image-builder'); g.fields.push('forgejo-webhook-secret=FORGEJO_WEBHOOK_SECRET'); g.mint.push('forgejo-webhook-secret'); },
    'a second row on the entry': steps => { steps.push(structuredClone(steps.find(s => s.path === LEAF))); },
    'written everywhere': steps => { const r = steps.find(s => s.path === LEAF); r.when = r.when.filter(w => w !== 'build_plane_here_in_answers'); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const steps = structuredClone(program.steps);
    plant(steps);
    assert.notDeepEqual(findings(steps), [], name);
  }
});

test('PLANTED INNOCENT: the rows in another order are not found', () => {
  assert.deepEqual(findings([...program.steps].reverse()), []);
});
