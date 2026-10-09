import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Every node keeps only the images its pods use: deploy-cluster hands the kubelet a configuration
// file whose imageMaximumGCAge collects an image unused for that long. A --config file brings the
// v1beta1 defaults, which differ from the flag defaults in four fields (Kubernetes v1.35.6
// cmd/kubelet/app/options/options.go applyLegacyDefaults); MicroK8s sets three of them as flags,
// so the file restates the fourth, authorization.mode, at today's AlwaysAllow and says nothing else.
// The same row raises the node's pod limit to 250, as a flag, because the file says nothing else.
const TEMPLATE = 'ansiwise/templates/kubelet-config.tpl';
const ARGS = '/var/snap/microk8s/current/args/kubelet';
const file = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const yaml = path => JSON.parse(execFileSync('yq', ['-o=json', '.', file(path)], {encoding: 'utf8'}));
const steps = yaml('ansiwise/programs/deploy-cluster.yaml').steps;
const config = existsSync(file(TEMPLATE)) ? yaml(TEMPLATE) : null;

/** Every way deploy-cluster misses giving the kubelet its image collection. */
function findings(rows, written) {
  const write = rows.findIndex(row => row.step === 'write_file_from_template' && row.template === TEMPLATE);
  if (write < 0 || !written) return ['the kubelet configuration is never written'];
  const path = rows[write].path;
  const flags = rows.findIndex((row, at) => at > write && row.step === 'set_process_flags' && row.args_path === ARGS);
  if (flags < 0) return ['no row hands the kubelet the file after it is written'];
  const row = rows[flags];
  const found = [];
  if (!(row.flags ?? []).includes(`--config=${path}`)) found.push(`the kubelet's flags name no --config=${path}`);
  const maxPods = (row.flags ?? []).filter(flag => flag.startsWith('--max-pods='));
  if (JSON.stringify(maxPods) !== JSON.stringify(['--max-pods=250'])) found.push(`the kubelet's pod limit is ${maxPods.join(' ') || 'the default 110'}, not 250`);
  if (JSON.stringify(row.restart_command) !== JSON.stringify(['snap', 'restart', 'microk8s.daemon-kubelite'])) found.push('the kubelet is not restarted');
  if (!row.ready_command) found.push('nothing waits for the cluster to answer again');
  if (written.kind !== 'KubeletConfiguration' || written.apiVersion !== 'kubelet.config.k8s.io/v1beta1') found.push(`the file is a ${written.apiVersion} ${written.kind}`);
  if (written.imageMaximumGCAge !== '36h') found.push(`imageMaximumGCAge is ${written.imageMaximumGCAge}`);
  if (written.authorization?.mode !== 'AlwaysAllow') found.push(`authorization.mode is ${written.authorization?.mode}, not today's AlwaysAllow`);
  const extra = Object.keys(written).filter(key => !['apiVersion', 'kind', 'authorization', 'imageMaximumGCAge'].includes(key));
  if (extra.length) found.push(`the file also sets ${extra.join(', ')}`);
  return found;
}

test('deploy-cluster gives the kubelet an image collection of 36 h and 250 pods, and changes nothing else', () => {
  assert.deepEqual(findings(steps, config), []);
});

test('PLANTED DEFECT: each way out is found, and the program itself is not', () => {
  const at = (rows, test) => rows.findIndex(test);
  const flagsRow = rows => rows[at(rows, row => row.step === 'set_process_flags' && row.args_path === ARGS)];
  const planted = {
    'never written': [rows => { rows.splice(at(rows, row => row.template === TEMPLATE), 1); }, config],
    'never handed to the kubelet': [rows => { rows.splice(at(rows, row => row.step === 'set_process_flags' && row.args_path === ARGS), 1); }, config],
    'another file named': [rows => { flagsRow(rows).flags = flagsRow(rows).flags.map(flag => flag.startsWith('--config=') ? '--config=/tmp/elsewhere.yaml' : flag); }, config],
    'the default pod limit': [rows => { flagsRow(rows).flags = flagsRow(rows).flags.filter(flag => !flag.startsWith('--max-pods=')); }, config],
    'another pod limit': [rows => { flagsRow(rows).flags = flagsRow(rows).flags.map(flag => flag.startsWith('--max-pods=') ? '--max-pods=110' : flag); }, config],
    'no restart': [rows => { delete flagsRow(rows).restart_command; }, config],
    'no age': [rows => {}, {...config, imageMaximumGCAge: undefined}],
    'webhook authorization slips in': [rows => {}, {...config, authorization: {mode: 'Webhook'}}],
    'a further setting rides along': [rows => {}, {...config, readOnlyPort: 0}],
  };
  for (const [name, [plant, written]] of Object.entries(planted)) {
    const rows = structuredClone(steps);
    plant(rows);
    assert.notDeepEqual(findings(rows, written), [], name);
  }
  assert.deepEqual(findings(structuredClone(steps), config), [], 'the planted innocent: the program as it is');
});
