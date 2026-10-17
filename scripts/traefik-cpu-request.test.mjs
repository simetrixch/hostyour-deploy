import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The MicroK8s ingress addon declares its Traefik DaemonSet with `resources: {}`, so a heavy build
// on the master gives the controller the minimum CPU share and every service behind it slows down.
// deploy-cluster sets the request. hostyour-cloud counts the same 400m in ciCapacity.standingCpuRequests
// (scripts/build-contract.test.mjs TRAEFIK_CPU), and nothing reads across the two repositories.
const CPU_REQUEST = '400m';
const file = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const yaml = path => JSON.parse(execFileSync('yq', ['-o=json', '.', file(path)], {encoding: 'utf8'}));
const steps = yaml('ansiwise/programs/deploy-cluster.yaml').steps;

/** Every way deploy-cluster leaves the ingress controller without its CPU request. */
function findings(rows) {
  const rowsOfTraefik = rows.filter(row => row.step === 'patch_container_resources' && row.namespace === 'ingress' && row.name === 'traefik');
  if (rowsOfTraefik.length === 0) return ['nothing sets the request of the traefik daemonset'];
  if (rowsOfTraefik.length > 1) return [`${rowsOfTraefik.length} rows set the request of the traefik daemonset`];
  const [row] = rowsOfTraefik;
  const found = [];
  if (row.kind !== 'daemonset') found.push(`kind ${row.kind}`);
  if (row.container !== 'traefik') found.push(`container ${row.container}`);
  if (row.cpu_request !== CPU_REQUEST) found.push(`requests ${row.cpu_request}`);
  if (row.when !== undefined) found.push('only on some machines');
  return found;
}

test('deploy-cluster makes the ingress controller request the CPU the build budget counts', () => {
  assert.deepEqual(findings(steps), []);
});

test('PLANTED DEFECT: each way to leave the controller without its request is found, and the program itself is not', () => {
  const at = rows => rows.findIndex(row => row.step === 'patch_container_resources' && row.name === 'traefik');
  const planted = {
    'the row is gone': rows => { rows.splice(at(rows), 1); },
    'the figure changed': rows => { rows[at(rows)].cpu_request = '100m'; },
    'another container': rows => { rows[at(rows)].container = 'sidecar'; },
    'only on some machines': rows => { rows[at(rows)].when = ['is_master']; },
    'the row twice': rows => { rows.push(structuredClone(rows[at(rows)])); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(steps)), [], 'the planted innocent: the program as it is');
});
