import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The storage box's addresses stand in the cluster map of the owner's master, where the person in charge
// writes them by hand, and deploy-branch rewrites that map on every run, a cold install and a restore
// included. So the template carries the line: a carried slot takes its value from the map as it stands
// and leaves the line out where none stands, and a slot of any other kind would drop the hand-written
// value or refuse the run that has no answer for it.
const TEMPLATE = 'ansiwise/templates/cluster-map.tpl';
const LINE = '  storageBoxCidrs: [<storage-box-cidrs!?>]';
const file = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const yaml = (text) => JSON.parse(execFileSync('yq', ['-o=json', '.'], {input: text, encoding: 'utf8'}));
const template = readFileSync(file(TEMPLATE), 'utf8');
const branch = JSON.parse(execFileSync('yq', ['-o=json', '.steps', file('ansiwise/programs/deploy-branch.yaml')], {encoding: 'utf8'}));

/** Every way the map's rewrite loses the hand-written addresses of the storage box. */
function findings(text, rows) {
  const found = [];
  const lines = text.split('\n').filter(line => /^\s*storageBoxCidrs:/.test(line));
  if (lines.length !== 1 || lines[0] !== LINE) found.push(`the map states the storage box as ${JSON.stringify(lines)}, not as the one line ${JSON.stringify(LINE)}`);
  const map = yaml(text.replace(/<([a-z-]+)[?!]*>/g, '__$1__'));
  if (JSON.stringify(map.global?.storageBoxCidrs) !== JSON.stringify(['__storage-box-cidrs__'])) found.push('the line does not stand under global as a list');
  const writes = rows.filter(row => row.step === 'write_file_from_template' && row.template === TEMPLATE);
  if (writes.length === 0) found.push('deploy-branch never writes the map');
  for (const row of writes) {
    if (Object.hasOwn(row.values ?? {}, 'storage-box-cidrs')) found.push(`the row writing ${row.path} hands the carried slot a value`);
  }
  return found;
}

test('the shipped map carries the storage box addresses through every rewrite', () => {
  assert.deepEqual(findings(template, branch), []);
});

test('the planted defects are caught', () => {
  assert.equal(template.split('\n').filter(line => line === LINE).length, 1, 'the plants below change nothing');
  const without = template.split('\n').filter(line => line !== LINE).join('\n');
  assert.notDeepEqual(findings(without, branch), [], 'a map without the line passes');
  assert.notDeepEqual(findings(template.replace(LINE, '  storageBoxCidrs: [<storage-box-cidrs>]'), branch), [], 'a slot that is not carried passes');
  const bound = structuredClone(branch);
  const row = bound.find(r => r.step === 'write_file_from_template' && r.template === TEMPLATE);
  row.values = {...row.values, 'storage-box-cidrs': {answer: 'storage_box_cidrs'}};
  assert.notDeepEqual(findings(template, bound), [], 'a row that answers the carried slot passes');
});
