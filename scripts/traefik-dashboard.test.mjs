import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The MicroK8s ingress addon installs Traefik with its dashboard route on `web`
// (Host(`dashboard.localhost`) to api@internal), and a Host header is anybody's to send, so every
// cluster address served its whole routing table. deploy-cluster takes that route off on every run,
// after its own patch of the controller, and only where it carries the addon's release label.
const TEMPLATE = 'ansiwise/templates/traefik-dashboard-route.tpl';
const file = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const yaml = path => JSON.parse(execFileSync('yq', ['-o=json', '.', file(path)], {encoding: 'utf8'}));
const steps = yaml('ansiwise/programs/deploy-cluster.yaml').steps;
const route = existsSync(file(TEMPLATE)) ? yaml(TEMPLATE) : null;

/** Every way deploy-cluster misses taking the dashboard route off. */
function findings(rows, written) {
  const found = [];
  const patch = rows.findIndex(row => row.step === 'patch_container_arguments_and_ports' && row.namespace === 'ingress' && row.name === 'traefik');
  const write = rows.findIndex(row => row.step === 'write_file_from_template' && row.template === TEMPLATE);
  if (patch < 0) found.push('no patch of the traefik daemonset to stand after');
  if (write < 0 || !written) return [...found, 'the dashboard route is never written'];
  const remove = rows.findIndex((row, at) => at > write && row.step === 'remove_kubernetes_object' && `${row.repository}/${row.manifest}` === rows[write].path);
  if (remove < 0) return [...found, 'nothing removes the written route'];
  if (write < patch) found.push('the route is taken off before the controller is patched');
  const row = rows[remove];
  if (row.owner_label !== 'app.kubernetes.io/instance' || row.owner_label_value !== 'traefik-ingress') found.push(`guarded by ${row.owner_label}=${row.owner_label_value}`);
  if (row.on_failure !== 'exit') found.push(`on_failure ${row.on_failure}`);
  if (row.when !== undefined || rows[write].when !== undefined) found.push('only on some machines');
  const {kind, metadata = {}} = written;
  if (`${kind} ${metadata.namespace}/${metadata.name}` !== 'IngressRoute ingress/traefik-dashboard') found.push(`the template names ${kind} ${metadata.namespace}/${metadata.name}`);
  return found;
}

test('deploy-cluster takes the addon\'s dashboard route off every cluster, guarded by the addon\'s label', () => {
  assert.deepEqual(findings(steps, route), []);
});

test('PLANTED DEFECT: each way to leave the dashboard on the web is found, and the program itself is not', () => {
  const at = (rows, step, extra = () => true) => rows.findIndex(row => row.step === step && extra(row));
  const removal = rows => rows[at(rows, 'remove_kubernetes_object', row => row.owner_label === 'app.kubernetes.io/instance')];
  const planted = {
    'the removal is gone': rows => { rows.splice(at(rows, 'remove_kubernetes_object', row => row.owner_label === 'app.kubernetes.io/instance'), 1); },
    'the route is never written': rows => { rows.splice(at(rows, 'write_file_from_template', row => row.template === TEMPLATE), 1); },
    'guarded by another label': rows => { removal(rows).owner_label_value = 'something-else'; },
    'a failure is let through': rows => { removal(rows).on_failure = 'continue'; },
    'only where a condition holds': rows => { removal(rows).when = ['planted']; },
    'before the controller patch': rows => {
      const [write] = rows.splice(at(rows, 'write_file_from_template', row => row.template === TEMPLATE), 1);
      rows.unshift(write);
    },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(steps);
    plant(rows);
    assert.notDeepEqual(findings(rows, route), [], name);
  }
  assert.notDeepEqual(findings(steps, {...route, metadata: {...route.metadata, name: 'planted'}}), [], 'another route named');
  assert.deepEqual(findings(structuredClone(steps), route), [], 'the planted innocent: the program as it is');
});
