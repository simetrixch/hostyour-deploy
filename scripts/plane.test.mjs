import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// What Plane on the master is handed. One row mints every secret of <stage>/app/plane, the six fields
// hostyour-cloud's plane inventory reads into its ExternalSecrets; a second row there would erase the
// first one's fields. deploy-branch writes installation/values/plane.yaml with this installation's
// address and the issuer of its certificate, which the chart cannot compose at render time.
const LEAF = '<stage>/app/plane';
const FIELDS = ['secret-key', 'live-server-secret-key', 'pgdb-password', 'rabbitmq-password', 'minio-access-key', 'minio-secret-key'];
const at = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', at(file)], {encoding: 'utf8'}));
const services = read('ansiwise/programs/deploy-platform-services.yaml');
const branch = read('ansiwise/programs/deploy-branch.yaml');
const templateText = readFileSync(at('ansiwise/templates/plane-values.tpl'), 'utf8');

/** Every way deploy-platform-services breaks the rule, named. */
function secretFindings(steps) {
  const rows = steps.filter(step => step.step === 'vault_kv_entry' && step.path === LEAF);
  if (rows.length !== 1) return [`${rows.length} rows write ${LEAF}, not 1`];
  const [row] = rows;
  const found = [];
  const named = row.fields.map(field => field.split('=')[0]);
  if (JSON.stringify([...named].sort()) !== JSON.stringify([...FIELDS].sort())) found.push(`${LEAF} holds ${named.join(', ')}`);
  const unminted = FIELDS.filter(field => !(row.mint ?? []).includes(field));
  if (unminted.length > 0) found.push(`${LEAF} does not mint ${unminted.join(', ')}, so an empty input refuses the run`);
  if (row.copy_from !== undefined) found.push(`${LEAF} copies a value another entry owns`);
  return found;
}

/** Every way deploy-branch breaks the rule, named. */
function valuesFindings(program, text) {
  const rows = program.steps.filter(step => step.step === 'write_file_from_template' && step.path === '/srv/hostyour-cloud/installation/values/plane.yaml');
  if (rows.length !== 1) return [`${rows.length} rows write installation/values/plane.yaml, not 1`];
  const [row] = rows;
  const found = [];
  if (row.template !== 'ansiwise/templates/plane-values.tpl' || row.file_mode !== 420) found.push('the file is not written from plane-values.tpl at mode 420');
  if (JSON.stringify(row.values) !== JSON.stringify({fqdn: {answer: 'fqdn'}, 'cluster-issuer': {answer: 'cluster_issuer'}})) found.push(`the slots are filled from ${JSON.stringify(row.values)}`);
  const filled = Object.entries({fqdn: 'planted.example', 'cluster-issuer': 'planted-issuer'})
    .reduce((out, [slot, value]) => out.replaceAll(`<${slot}>`, value), text);
  const unfilled = filled.split('\n').filter(line => !line.trimStart().startsWith('#') && /<[a-z-]+>/.test(line));
  if (unfilled.length > 0) found.push(`slots no answer fills: ${unfilled.join(' | ')}`);
  const ingress = JSON.parse(execFileSync('yq', ['-o=json', '.["plane-ce"].ingress', '-'], {input: filled, encoding: 'utf8'}));
  if (ingress?.appHost !== 'plane.planted.example') found.push(`Plane is told it stands at ${ingress?.appHost}`);
  if (JSON.stringify(ingress?.ingress_annotations) !== JSON.stringify({'cert-manager.io/cluster-issuer': 'planted-issuer'})) found.push(`the annotations are ${JSON.stringify(ingress?.ingress_annotations)}, not the issuer alone`);
  return found;
}

test('one row mints every secret of Plane\'s entry', () => {
  assert.deepEqual(secretFindings(services.steps), []);
});

test('installation/values/plane.yaml carries the address and the issuer', () => {
  assert.deepEqual(valuesFindings(branch, templateText), []);
});

test('PLANTED DEFECT: a second row on the entry, a field left unminted and a copied field are found', () => {
  const planted = {
    'a second row erases the first': steps => { steps.push({...steps.find(s => s.path === LEAF), fields: ['planted=PLANTED'], mint: ['planted']}); },
    'a field left unminted': steps => { const row = steps.find(s => s.path === LEAF); row.mint = row.mint.filter(f => f !== 'pgdb-password'); },
    'a field copied from the provider': steps => { steps.find(s => s.path === LEAF).copy_from = ['secret-key=<stage>/idp/bootstrap:argocd-client-secret']; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const steps = structuredClone(services.steps);
    plant(steps);
    assert.notDeepEqual(secretFindings(steps), [], name);
  }
});

test('PLANTED DEFECT: a template without the issuer, a slot no answer fills and the forward auth moved here are found', () => {
  assert.notDeepEqual(valuesFindings(branch, templateText.replace(/\n\s*ingress_annotations:\n.*cluster-issuer.*/, '')), []);
  assert.notDeepEqual(valuesFindings(branch, templateText.replace('plane.<fqdn>', 'plane.<domain>')), []);
  assert.notDeepEqual(valuesFindings(branch, templateText.replace('cert-manager.io/cluster-issuer: <cluster-issuer>', 'cert-manager.io/cluster-issuer: <cluster-issuer>\n      traefik.ingress.kubernetes.io/router.middlewares: planted')), []);
});

test('PLANTED INNOCENT: another comment in the template and the rows in another order are not found', () => {
  assert.deepEqual(valuesFindings(branch, `# planted comment naming <nothing>\n${templateText}`), []);
  assert.deepEqual(secretFindings([...services.steps].reverse()), []);
});
