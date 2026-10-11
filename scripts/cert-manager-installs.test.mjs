import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// cert-manager, its issuers, trust-manager and the Bundle stand under Argo CD. The installer installs
// each only where none stands, from hostyour-cloud's inventory chart, in deploy-platform-services
// before the secret store, and never touches the microk8s addon: disabling it uninstalls the CRDs and
// with them every Certificate and Issuer on the cluster.
const root = fileURLToPath(new URL('..', import.meta.url));
const yq = (args, input) => JSON.parse(execFileSync('yq', ['-o=json', ...args], {input, encoding: 'utf8'}));
const programs = Object.fromEntries(readdirSync(`${root}ansiwise/programs`).filter(f => f.endsWith('.yaml'))
  .map(f => [f.replace(/\.yaml$/, ''), yq(['.steps', `${root}ansiwise/programs/${f}`])]));
const conditions = yq(['.conditions', `${root}ansiwise.yaml`]);
const templates = Object.fromEntries(readdirSync(`${root}ansiwise/templates`)
  .map(f => [`ansiwise/templates/${f}`, readFileSync(`${root}ansiwise/templates/${f}`, 'utf8')]));

const INVENTORY = '/srv/hostyour-cloud/clusters/inventories';
const RUN_VALUES = '/tmp/ansiwise-certificate-values.yaml';
// Each install, the values it is given, and the one object whose absence lets it run.
const INSTALLS = {
  'cert-manager': {values: `${INVENTORY}/cert-manager/values-common.yaml`, absent: [['deployment', 'cert-manager', 'cert-manager']]},
  'cert-manager-issuers': {values: RUN_VALUES, absent: [['clusterissuer', 'platform-acme'], ['clusterissuer', 'platform-local']]},
  'trust-manager': {values: `${INVENTORY}/trust-manager/values-common.yaml`, absent: [['deployment', 'trust-manager', 'cert-manager']]},
  'trust-manager-bundles': {values: RUN_VALUES, absent: [['bundle', 'platform-trust']]},
};
const ISSUER_SWITCH = {'platform-acme': 'certificates_enabled', 'platform-local': 'certificates_withheld'};
const RETIRED_STEPS = ['write_cluster_issuer_manifest', 'apply_cluster_issuer', 'restart_cert_manager_and_reapply_cluster_issuer', 'remove_existing_cluster_issuer'];
const TEMPLATE_KEYS = ['global.clusterIssuer', 'global.letsencryptEmail', 'global.letsencryptServer'];

const kindOf = kind => String(kind).toLowerCase().split('.')[0].replace(/s$/, '');
const installOf = row => row.step === 'helm_release'
  ? Object.keys(INSTALLS).find(name => row.release === name || String(row.chart).endsWith(`/${name}`)) : undefined;
/** The object the condition [name] of [conditions] asks to be absent, as [kind, name, namespace]. */
const absenceOf = (conditions, name) => {
  const c = conditions[name];
  return c?.predicate === 'kubernetes_object_absent' ? [kindOf(c.kind), c.name, c.namespace].filter(Boolean) : undefined;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const leaves = (value, path = []) => value !== null && typeof value === 'object'
  ? Object.entries(value).flatMap(([k, v]) => leaves(v, [...path, k])) : [[path.join('.'), value]];

/** Every way the programs break the rule, named. */
function findings({programs, conditions, templates}) {
  const found = [];
  for (const [program, steps] of Object.entries(programs)) {
    steps.forEach((row, at) => {
      const where = `${program}[${at}] ${row.step}`;
      const text = JSON.stringify(row);
      if ((row.addons ?? []).includes('cert-manager') || /\b(enable|disable)\b[^"]*\bcert-manager\b/.test(text)) found.push(`${where} switches the cert-manager addon`);
      if (RETIRED_STEPS.includes(row.step)) found.push(`${where} writes, applies or restarts for an issuer of the installer's own`);
      if (/^kind:\s*ClusterIssuer\b/m.test(templates[row.template] ?? '')) found.push(`${where} renders a ClusterIssuer of its own`);
      if (text.includes('clusters/bootstrap/cert-manager')) found.push(`${where} reads clusters/bootstrap/cert-manager`);
      const name = installOf(row);
      if (name && program !== 'deploy-platform-services') found.push(`${where} installs ${name} outside deploy-platform-services`);
    });
  }

  const steps = programs['deploy-platform-services'] ?? [];
  const store = steps.findIndex(row => (row.when ?? []).includes('secret_store_enabled'));
  const at = name => steps.flatMap((row, i) => installOf(row) === name ? [i] : []);
  for (const [name, wanted] of Object.entries(INSTALLS)) {
    const rows = at(name);
    if (rows.length === 0) found.push(`nothing installs ${name}`);
    const seen = [];
    for (const i of rows) {
      const row = steps[i];
      const where = `deploy-platform-services[${i}] ${name}`;
      if (store < 0 || i > store) found.push(`${where} stands after the secret store's first row`);
      if (row.release !== name || row.namespace !== 'cert-manager') found.push(`${where} is release ${row.release} in ${row.namespace}`);
      if (row.chart !== `${INVENTORY}/${name}`) found.push(`${where} installs ${row.chart}`);
      if (row.chart_version !== undefined) found.push(`${where} pins a version beside its Chart.yaml`);
      if (row.values !== wanted.values) found.push(`${where} is given ${row.values}`);
      const guard = (row.when ?? []).map(w => absenceOf(conditions, w)).find(object => wanted.absent.some(each => same(each, object)));
      if (!guard) {
        found.push(`${where} runs without the absence of its own object`);
        continue;
      }
      seen.push(guard[1]);
      if (name === 'cert-manager-issuers' && !(row.when ?? []).includes(ISSUER_SWITCH[guard[1]])) found.push(`${where} installs ${guard[1]} without ${ISSUER_SWITCH[guard[1]]}`);
    }
    for (const [, object] of wanted.absent) {
      if (rows.length > 0 && !seen.includes(object)) found.push(`nothing installs ${name} where ${object} is absent`);
    }
  }

  const waitsFor = (from, to, chart) => steps.slice(from + 1, to).some(row => row.step === 'wait_for_command_output'
    && JSON.stringify(row.command_arguments ?? []).includes('--dry-run=server') && JSON.stringify(row.command_arguments ?? []).includes(`${INVENTORY}/${chart}`));
  for (const [first, second] of [['cert-manager', 'cert-manager-issuers'], ['trust-manager', 'trust-manager-bundles']]) {
    const [before] = at(first);
    const later = at(second);
    if (before === undefined || later.length === 0) continue;
    if (later.some(i => i < before)) found.push(`${second} stands before ${first}`);
    else if (!waitsFor(before, Math.min(...later), second)) found.push(`no admission wait for ${second} between ${first} and it`);
  }

  const writes = steps.flatMap((row, i) => row.step === 'write_file_from_template' && row.path === RUN_VALUES ? [[i, row]] : []);
  for (const [issuer, switched] of Object.entries(ISSUER_SWITCH)) {
    const mine = writes.filter(([, row]) => same(row.when, [switched]));
    if (mine.length !== 1) found.push(`${mine.length} values files written under ${switched}`);
  }
  for (const [i, row] of writes) {
    const where = `deploy-platform-services[${i}] the run's values`;
    const issuer = Object.keys(ISSUER_SWITCH).find(each => same(row.when, [ISSUER_SWITCH[each]]));
    if (!issuer) found.push(`${where} is written under ${JSON.stringify(row.when)}`);
    const readers = steps.flatMap((each, j) => JSON.stringify(each).includes(RUN_VALUES) && !writes.some(([, w]) => w === each) ? [j] : []);
    if (readers.some(j => j < i)) found.push(`${where} is written after a row reads it`);
    let values;
    try {
      values = yq(['.'], (templates[row.template] ?? '').replace(/<([a-z-]+)>/g, '__$1__'));
    } catch {
      found.push(`${where}: ${row.template} is no YAML`);
      continue;
    }
    const answers = Object.fromEntries(Object.entries(row.values ?? {}).map(([slot, from]) => [`__${slot}__`, from?.answer]));
    if (Object.values(row.values ?? {}).some(from => !['letsencrypt_email', 'letsencrypt_server'].includes(from?.answer) || Object.keys(from).length !== 1)) found.push(`${where} is filled from ${JSON.stringify(row.values)}`);
    const held = Object.fromEntries(leaves(values ?? {}));
    for (const key of Object.keys(held)) {
      if (!TEMPLATE_KEYS.includes(key)) found.push(`${where} holds ${key}`);
    }
    if (issuer && held['global.clusterIssuer'] !== issuer) found.push(`${where} names the issuer ${held['global.clusterIssuer']}`);
    if (issuer === 'platform-acme') {
      if (answers[held['global.letsencryptEmail']] !== 'letsencrypt_email') found.push(`${where} takes the ACME contact from ${held['global.letsencryptEmail']}`);
      if (answers[held['global.letsencryptServer']] !== 'letsencrypt_server') found.push(`${where} takes the ACME directory from ${held['global.letsencryptServer']}`);
    }
  }

  const trust = steps.findIndex(row => row.step === 'trust_cluster_authority');
  const unseal = steps.findIndex(row => row.step === 'vault_init');
  if (trust < 0) found.push('deploy-platform-services does not trust the cluster authority');
  else {
    if (!(steps[trust].when ?? []).includes('certificates_withheld')) found.push('trust_cluster_authority runs without certificates_withheld');
    if (unseal >= 0 && trust > unseal) found.push('trust_cluster_authority stands after vault_init');
  }
  return found;
}

test('the programs leave cert-manager to Argo CD and install it only where none stands', () => {
  assert.deepEqual(findings({programs, conditions, templates}), []);
});

const at = (rows, test) => rows.findIndex(test);
const release = name => row => installOf(row) === name;
const PLANTED = {
  'the addon enabled again': p => { p.programs['deploy-cluster'].find(r => r.step === 'enable_addons').addons.push('cert-manager'); },
  'the addon disabled': p => { p.programs['deploy-cluster'].push({step: 'disable_addons', addons: ['cert-manager']}); },
  'the addon disabled through a shell': p => { p.programs['deploy-host'].push({step: 'run_command', command: 'sh', command_arguments: ['-c', 'microk8s disable cert-manager']}); },
  'an issuer written by the installer': p => { p.programs['deploy-cluster'].push({step: 'write_cluster_issuer_manifest', name: 'platform-acme'}); },
  'an issuer applied by the installer': p => { p.programs['deploy-cluster'].push({step: 'apply_cluster_issuer', name: 'platform-acme'}); },
  'the issuer restarted': p => { p.programs['deploy-cluster'].push({step: 'restart_cert_manager_and_reapply_cluster_issuer'}); },
  'an issuer removed': p => { p.programs['deploy-cluster'].push({step: 'remove_existing_cluster_issuer', name: 'letsencrypt-prod'}); },
  'a template of kind ClusterIssuer': p => {
    p.templates['ansiwise/templates/planted.tpl'] = 'apiVersion: cert-manager.io/v1\nkind: ClusterIssuer\n';
    p.programs['deploy-cluster'].push({step: 'write_file_from_template', template: 'ansiwise/templates/planted.tpl', path: '/tmp/x'});
  },
  'a row reading clusters/bootstrap/cert-manager': p => { p.programs['deploy-platform-services'].push({step: 'kubernetes_object_reversible', repository: '/srv/hostyour-cloud', manifest: 'clusters/bootstrap/cert-manager/trust-bundle-public.yaml'}); },
  'cert-manager installed by deploy-cluster': p => {
    const rows = p.programs['deploy-platform-services'];
    p.programs['deploy-cluster'].push(rows[at(rows, release('cert-manager'))]);
  },
  'trust-manager installed after the store': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, release('trust-manager')), 1);
    rows.push(row);
  },
  'trust-manager from the jetstack repository': p => {
    const rows = p.programs['deploy-platform-services'];
    Object.assign(rows[at(rows, release('trust-manager'))], {chart: 'jetstack/trust-manager', chart_version: 'v0.24.0'});
  },
  'cert-manager with the bootstrap values': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, release('cert-manager'))].values = '/srv/hostyour-cloud/clusters/inventories/cert-manager/values-prod.yaml';
  },
  'the Bundle with a values file of its own': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, release('trust-manager-bundles'))].values = `${INVENTORY}/trust-manager-bundles/values-common.yaml`;
  },
  'cert-manager unguarded': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, release('cert-manager'))].when = [];
  },
  'the Bundle guarded by another object': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, release('trust-manager-bundles'))].when = [...rows[at(rows, release('trust-manager'))].when];
  },
  'the local issuer guarded by the public one': p => {
    const rows = p.programs['deploy-platform-services'];
    const local = rows.find(r => installOf(r) === 'cert-manager-issuers' && r.when.includes('certificates_withheld'));
    local.when = local.when.map(w => absenceOf(p.conditions, w) ? Object.keys(p.conditions).find(c => same(absenceOf(p.conditions, c), ['clusterissuer', 'platform-acme'])) : w);
  },
  'a guard that is no absence': p => {
    const rows = p.programs['deploy-platform-services'];
    const row = rows[at(rows, release('trust-manager'))];
    p.conditions[row.when[0]] = {predicate: 'key_has_value', file: '/x', key: 'K', value: 'v'};
  },
  'the issuers before cert-manager': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, release('cert-manager')), 1);
    rows.splice(at(rows, release('cert-manager-issuers')) + 1, 0, row);
  },
  'the Bundle without its admission wait': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, r => r.step === 'wait_for_command_output' && JSON.stringify(r).includes('trust-manager-bundles')), 1);
  },
  'the issuers without their admission wait': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, r => r.step === 'wait_for_command_output' && JSON.stringify(r).includes('cert-manager-issuers')), 1);
  },
  'a values template holding another key': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_withheld']));
    p.templates[row.template] += '  ingressClass: public\n';
  },
  'a values template naming the other issuer': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_withheld']));
    p.templates[row.template] = p.templates[row.template].replace('platform-local', 'platform-acme');
  },
  'the ACME contact from another answer': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    for (const from of Object.values(row.values)) if (from.answer === 'letsencrypt_email') from.answer = 'operator_email';
  },
  'the values written under another condition': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    row.when = ['secret_store_enabled'];
  },
  'trust_cluster_authority gone': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, r => r.step === 'trust_cluster_authority'), 1);
  },
  'trust_cluster_authority on every cluster': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, r => r.step === 'trust_cluster_authority')].when = [];
  },
  'trust_cluster_authority after vault_init': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, r => r.step === 'trust_cluster_authority'), 1);
    rows.splice(at(rows, r => r.step === 'vault_init') + 1, 0, row);
  },
};
const INNOCENT = {
  'another addon enabled': p => { p.programs['deploy-cluster'].find(r => r.step === 'enable_addons').addons.push('observability'); },
  'the issuer read by a wait': p => { p.programs['deploy-cluster'].push({step: 'wait_for_command_output', command_arguments: ['kubectl', 'get', 'clusterissuer', 'platform-acme']}); },
  'the values template keys in another order': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    const keys = p.templates[row.template].split('\n').filter(l => /^ {2}\w/.test(l));
    p.templates[row.template] = `global:\n${keys.reverse().join('\n')}\n`;
  },
};

test('PLANTED DEFECT: each way back is found, and the programs as built are not', () => {
  for (const [name, plant] of Object.entries(PLANTED)) {
    const planted = structuredClone({programs, conditions, templates});
    plant(planted);
    assert.notDeepEqual(findings(planted), [], name);
  }
});

test('PLANTED INNOCENT: what the rule does not forbid stays green', () => {
  for (const [name, plant] of Object.entries(INNOCENT)) {
    const planted = structuredClone({programs, conditions, templates});
    plant(planted);
    assert.deepEqual(findings(planted), [], name);
  }
});
