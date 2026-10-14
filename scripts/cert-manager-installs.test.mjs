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
const answers = Object.fromEntries(readdirSync(`${root}ansiwise/programs`).filter(f => f.endsWith('.yaml'))
  .map(f => [f.replace(/\.yaml$/, ''), yq(['.answers // []', `${root}ansiwise/programs/${f}`])]));
const templates = Object.fromEntries(readdirSync(`${root}ansiwise/templates`)
  .map(f => [`ansiwise/templates/${f}`, readFileSync(`${root}ansiwise/templates/${f}`, 'utf8')]));

const INVENTORY = '/srv/hostyour-cloud/clusters/inventories';
const RUN_VALUES = '/tmp/ansiwise-certificate-values.yaml';
// A dry run writes no values file, so a probe that renders with it asks first and, where it is not
// there, says why it cannot measure instead of printing helm's refusal of the missing file.
const DRY_GUARD = new RegExp(`^test -r ${RUN_VALUES.replace(/\./g, '\\.')} \\|\\| \\{ echo "[^"]+"; exit 0; \\}; `);
// Each install, the values it is given, and the one object whose absence lets it run.
const INSTALLS = {
  'cert-manager': {values: `${INVENTORY}/cert-manager/values-common.yaml`, absent: [['deployment', 'cert-manager', 'cert-manager']]},
  'cert-manager-issuers': {values: RUN_VALUES, absent: [['clusterissuer', 'platform-acme'], ['clusterissuer', 'platform-local']]},
  'trust-manager': {values: `${INVENTORY}/trust-manager/values-common.yaml`, absent: [['deployment', 'trust-manager', 'cert-manager']]},
  'trust-manager-bundles': {values: RUN_VALUES, absent: [['bundle', 'platform-trust']]},
};
const ISSUER_SWITCH = {'platform-acme': 'certificates_enabled', 'platform-local': 'certificates_withheld'};
const TEMPLATE_KEYS = ['global.clusterIssuer', 'global.letsencryptEmail', 'global.letsencryptServer', 'global.acmeEabKeyId'];
const VALUES_ANSWERS = ['letsencrypt_email', 'letsencrypt_server', 'acme_eab_key_id'];

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
function findings({programs, conditions, templates, answers}) {
  const found = [];
  const optional = (program, name) => (answers[program] ?? []).find(a => a.name === name)?.required === false;
  for (const [program, steps] of Object.entries(programs)) {
    steps.forEach((row, at) => {
      const where = `${program}[${at}] ${row.step}`;
      const text = JSON.stringify(row);
      if ((row.addons ?? []).includes('cert-manager') || /\b(enable|disable)\b[^"]*\bcert-manager\b/.test(text)) found.push(`${where} switches the cert-manager addon`);
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
      // helm is not asked to create the namespace, and the addon that did is gone: a row creates it
      // first, under no condition the install does not carry.
      if (!steps.slice(0, i).some(each => each.step === 'kubernetes_namespace' && each.namespace === row.namespace
        && (each.when ?? []).every(w => (row.when ?? []).includes(w)))) found.push(`${where} lands in ${row.namespace}, which no row before it creates`);
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
    if (row.on_failure !== 'exit') found.push(`${where} lets the run go on without its values`);
    let values;
    try {
      values = yq(['.'], (templates[row.template] ?? '').replace(/<([a-z-]+)\??>/g, '__$1__'));
    } catch {
      found.push(`${where}: ${row.template} is no YAML`);
      continue;
    }
    const bound = Object.fromEntries(Object.entries(row.values ?? {}).map(([slot, from]) => [`__${slot}__`, from?.answer]));
    if (Object.values(row.values ?? {}).some(from => !VALUES_ANSWERS.includes(from?.answer) || Object.keys(from).length !== 1)) found.push(`${where} is filled from ${JSON.stringify(row.values)}`);
    // A slot fed by an optional answer is written <slot?>: the engine leaves an unanswered source
    // out, and only that spelling drops the line instead of refusing the run.
    for (const [slot, from] of Object.entries(row.values ?? {})) {
      if (optional('deploy-platform-services', from?.answer) && (templates[row.template] ?? '').includes(`<${slot}>`)) found.push(`${where} requires <${slot}>, so a run without ${from.answer} is refused`);
    }
    const held = Object.fromEntries(leaves(values ?? {}));
    for (const key of Object.keys(held)) {
      if (!TEMPLATE_KEYS.includes(key)) found.push(`${where} holds ${key}`);
    }
    if (issuer && held['global.clusterIssuer'] !== issuer) found.push(`${where} names the issuer ${held['global.clusterIssuer']}`);
    if (issuer === 'platform-acme') {
      if (bound[held['global.letsencryptEmail']] !== 'letsencrypt_email') found.push(`${where} takes the ACME contact from ${held['global.letsencryptEmail']}`);
      if (bound[held['global.letsencryptServer']] !== 'letsencrypt_server') found.push(`${where} takes the ACME directory from ${held['global.letsencryptServer']}`);
      if (bound[held['global.acmeEabKeyId']] !== 'acme_eab_key_id') found.push(`${where} takes the ACME account binding from ${held['global.acmeEabKeyId']}`);
    }
  }

  for (const [program, rows] of Object.entries(programs)) {
    rows.forEach((row, i) => {
      if (row.step !== 'wait_for_command_output' || !JSON.stringify(row).includes(RUN_VALUES)) return;
      const [flag, script] = row.command_arguments ?? [];
      if (row.command !== 'sh' || flag !== '-c' || !DRY_GUARD.test(script ?? '')) found.push(`${program}[${i}] reads ${RUN_VALUES} where a dry run wrote none`);
    });
  }

  const trust = steps.findIndex(row => row.step === 'trust_cluster_authority');
  const unseal = steps.findIndex(row => row.step === 'vault_init');
  if (trust < 0) found.push('deploy-platform-services does not trust the cluster authority');
  else {
    if (!(steps[trust].when ?? []).includes('certificates_withheld')) found.push('trust_cluster_authority runs without certificates_withheld');
    if (unseal >= 0 && trust > unseal) found.push('trust_cluster_authority stands after vault_init');
  }
  return [...found, ...accountFindings({programs, templates, answers}), ...directoryFindings({programs})];
}

// THE ONE DIRECTORY. Every cluster's issuer binds the one account registered at Google Trust Services'
// production directory, so deploy-cluster's first row admits that directory and no other: a Let's
// Encrypt directory knows no such account, and a test directory signs with a root no machine carries.
// Read with the row's own pattern, as the engine reads it (a search, so the anchors are the pattern's).
const GTS_DIRECTORY = 'https://dv.acme-v02.api.pki.goog/directory';
const REFUSED_DIRECTORIES = [
  'https://acme-v02.api.letsencrypt.org/directory',
  'https://acme-staging-v02.api.letsencrypt.org/directory',
  'https://dv.acme-v02.test-api.pki.goog/directory',
  'https://dv.acme-v02.api.pki.goog/directory/x',
  'https://evil.example/?https://dv.acme-v02.api.pki.goog/directory',
];
function directoryFindings({programs}) {
  const steps = programs['deploy-cluster'];
  const rows = steps.filter(row => row.step === 'require_answer_matches' && row.answer === 'letsencrypt_server');
  if (rows.length !== 1) return [`deploy-cluster holds ${rows.length} rows judging letsencrypt_server`];
  const [row] = rows;
  const found = [];
  if (steps.indexOf(row) !== 0) found.push(`deploy-cluster judges letsencrypt_server at row ${steps.indexOf(row)}, not before anything is written`);
  if (row.on_failure !== 'exit') found.push(`deploy-cluster's directory row goes on after a refusal (${row.on_failure})`);
  const admits = directory => new RegExp(row.pattern).test(directory);
  if (!admits(GTS_DIRECTORY)) found.push(`deploy-cluster refuses ${GTS_DIRECTORY}`);
  for (const directory of REFUSED_DIRECTORIES) if (admits(directory)) found.push(`deploy-cluster admits ${directory}`);
  return found;
}

// THE ONE ACME ACCOUNT (Google Trust Services). The key id of its External Account Binding is an
// optional answer: deploy-branch writes it into the cluster's map, where Argo CD renders the issuer
// from it, and deploy-platform-services hands it to the issuers it installs itself. Its MAC key is a
// secret answer that reaches Vault through the credentials file, and the account key is minted in
// Vault once. Both seed rows stand where every other seed of the installation stands: on the books
// cluster, with the secret store up. Every part optional, and the key id's slots written <slot?>, so
// a run without the answer writes no line rather than an empty one, and hostyour-cloud's issuer chart
// refuses that map by the key's name.
const SEED_WHEN = ['secret_store_enabled', 'books_here_in_answers'];
const ACCOUNT_SEEDS = {
  '<stage>/app/acme-eab': {step: 'vault_kv_entry', fields: ['mac-key=ACME_EAB_MAC_KEY'], optional_fields: ['mac-key']},
  '<stage>/app/acme-account': {step: 'vault_kv_dkim_key_pair', private_key_field: 'private-key', public_key_field: 'public-key'},
};
const DKIM_PUBLISHES = 'dkim_public_key';

/** Every way the programs fail to carry the one ACME account, named. */
function accountFindings({programs, templates, answers}) {
  const found = [];
  const declared = (program, name) => (answers[program] ?? []).find(a => a.name === name);
  const optionalText = (program, name, secret) => {
    const a = declared(program, name);
    if (!a) return found.push(`${program} declares no ${name}`);
    if (a.kind !== 'text' || a.required !== false) found.push(`${program} declares ${name} as ${a.kind}, required ${a.required}`);
    if ((a.secret === true) !== secret) found.push(`${program} declares ${name} ${secret ? 'without' : 'with'} secret`);
    if (a.default !== undefined) found.push(`${program} gives ${name} a default`);
  };
  optionalText('deploy-branch', 'acme_eab_key_id', false);
  optionalText('deploy-branch', 'acme_eab_mac_key', true);
  optionalText('deploy-platform-services', 'acme_eab_key_id', false);

  const branch = programs['deploy-branch'] ?? [];
  const map = branch.find(row => row.step === 'write_file_from_template' && row.template === 'ansiwise/templates/cluster-map.tpl');
  const mapLine = /^ {2}acmeEabKeyId: <([a-z-]+)(\??)>$/m.exec(templates['ansiwise/templates/cluster-map.tpl'] ?? '');
  if (!map) found.push('deploy-branch writes no cluster map');
  else if (!mapLine) found.push('the cluster map writes no acmeEabKeyId line under global');
  else if (mapLine[2] !== '?') found.push(`the cluster map requires <${mapLine[1]}>, so a run without acme_eab_key_id is refused`);
  else if (map.values?.[mapLine[1]]?.answer !== 'acme_eab_key_id' || Object.keys(map.values[mapLine[1]]).length !== 1) found.push(`the cluster map fills acmeEabKeyId from ${JSON.stringify(map.values?.[mapLine[1]])}`);
  const fills = branch.filter(row => row.step === 'fill_key_value_file' && row.path === '/srv/hostyour-cloud/secrets/secrets.<stage>'
    && row.values?.ACME_EAB_MAC_KEY !== undefined);
  if (fills.length !== 1) found.push(`${fills.length} credentials rows of deploy-branch fill ACME_EAB_MAC_KEY`);
  for (const row of fills) {
    if (row.values.ACME_EAB_MAC_KEY.answer !== 'acme_eab_mac_key') found.push(`deploy-branch fills ACME_EAB_MAC_KEY from ${JSON.stringify(row.values.ACME_EAB_MAC_KEY)}`);
    if (row.holds_credentials !== true || row.file_mode !== 384) found.push('deploy-branch fills ACME_EAB_MAC_KEY into a file not held as credentials');
    if (row.when !== undefined) found.push(`deploy-branch fills ACME_EAB_MAC_KEY only under ${JSON.stringify(row.when)}`);
  }

  const services = programs['deploy-platform-services'] ?? [];
  for (const [path, wanted] of Object.entries(ACCOUNT_SEEDS)) {
    const rows = services.filter(row => row.path === path);
    if (rows.length !== 1) {
      found.push(`${rows.length} rows of deploy-platform-services write ${path}`);
      continue;
    }
    const [row] = rows;
    for (const [key, value] of Object.entries(wanted)) {
      if (!same(row[key], value)) found.push(`${path} is written with ${key} ${JSON.stringify(row[key])}`);
    }
    for (const key of ['mint', 'fields_from_answers', 'copy_from', 'fields_owned_elsewhere']) {
      if (row[key] !== undefined) found.push(`${path} is written with ${key}`);
    }
    if (!same(row.when, SEED_WHEN)) found.push(`${path} is seeded under ${JSON.stringify(row.when)}`);
    if (row.repository !== '/srv/hostyour-cloud' || row.mount !== 'secret' || row.rests_on_an_earlier_step !== true || row.on_failure !== 'exit') found.push(`${path} is seeded unlike the installation's other seeds`);
  }
  // THE WAIT FOR THE ACCOUNT TO REGISTER COMES AFTER WHAT DELIVERS IT. The issuer signs with the key
  // ExternalSecret platform-acme-account delivers out of the two seeded entries, through Argo CD
  // (hostyour-cloud cert-manager-account), so it can register only after both seeds and after the
  // handoff; before them, a first run waits for an account nothing can deliver yet. Its window
  // covers the delivery: on master1 the Secret came 168 seconds after the seeds (ESO's backoff).
  const handoff = services.findIndex(row => row.manifest === 'clusters/argocd/root-app.yaml');
  const waits = services.flatMap((row, i) => row.step === 'wait_for_command_output'
    && same((row.command_arguments ?? []).slice(1, 4), ['get', 'clusterissuer', 'platform-acme']) ? [i] : []);
  const seeds = Object.keys(ACCOUNT_SEEDS).map(path => services.findIndex(row => row.path === path));
  if (waits.length !== 1) found.push(`${waits.length} rows of deploy-platform-services wait for platform-acme`);
  for (const i of waits) {
    if (seeds.some(seed => i < seed)) found.push(`deploy-platform-services[${i}] waits for platform-acme before the account is seeded`);
    if (i < handoff) found.push(`deploy-platform-services[${i}] waits for platform-acme before the handoff delivers the account`);
    if (!(services[i].timeout_seconds >= 600)) found.push(`deploy-platform-services[${i}] waits ${services[i].timeout_seconds}s for platform-acme`);
  }
  // ONE NAME PER MEASUREMENT IN A PROGRAM. A key pair row publishes its public half under the name
  // its kind declares unless it renames it, and the engine refuses a program in which two rows
  // publish one name, whatever their conditions, before its first row runs.
  for (const [program, steps] of Object.entries(programs)) {
    const names = steps.filter(row => row.step === 'vault_kv_dkim_key_pair').map(row => row.publish?.[DKIM_PUBLISHES] ?? DKIM_PUBLISHES);
    for (const name of new Set(names)) {
      if (names.filter(each => each === name).length > 1) found.push(`${program} publishes ${name} from ${names.filter(each => each === name).length} key pair rows`);
    }
  }
  return found;
}

test('the programs leave cert-manager to Argo CD and install it only where none stands', () => {
  assert.deepEqual(findings({programs, conditions, templates, answers}), []);
});

const at = (rows, test) => rows.findIndex(test);
const release = name => row => installOf(row) === name;
const accountWait = r => r.step === 'wait_for_command_output' && JSON.stringify(r.command_arguments ?? []).includes('"clusterissuer","platform-acme"');
const valuesProbe = chart => r => r.step === 'wait_for_command_output' && JSON.stringify(r.command_arguments ?? []).includes(`${INVENTORY}/${chart} `);
const PLANTED = {
  'the addon enabled again': p => { p.programs['deploy-cluster'].find(r => r.step === 'enable_addons').addons.push('cert-manager'); },
  'the addon disabled': p => { p.programs['deploy-cluster'].push({step: 'disable_addons', addons: ['cert-manager']}); },
  'the addon disabled through a shell': p => { p.programs['deploy-host'].push({step: 'run_command', command: 'sh', command_arguments: ['-c', 'microk8s disable cert-manager']}); },
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
  'the namespace created by nothing': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, r => r.step === 'kubernetes_namespace' && r.namespace === 'cert-manager'), 1);
  },
  'the namespace created after cert-manager': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, r => r.step === 'kubernetes_namespace' && r.namespace === 'cert-manager'), 1);
    rows.splice(at(rows, release('cert-manager')) + 1, 0, row);
  },
  'the namespace created only where cert-manager is absent': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, r => r.step === 'kubernetes_namespace' && r.namespace === 'cert-manager')].when = [...rows[at(rows, release('cert-manager'))].when];
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
  'the acmeEabKeyId line missing from the values where the answer is given': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    p.templates[row.template] = p.templates[row.template].split('\n').filter(l => !l.includes('acmeEabKeyId')).join('\n');
  },
  'the acmeEabKeyId line missing from the cluster map where the answer is given': p => {
    p.templates['ansiwise/templates/cluster-map.tpl'] = p.templates['ansiwise/templates/cluster-map.tpl'].split('\n').filter(l => !l.includes('acmeEabKeyId')).join('\n');
  },
  'the values template requiring the key id slot': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    p.templates[row.template] = p.templates[row.template].replace('<acme-eab-key-id?>', '<acme-eab-key-id>');
  },
  'the cluster map requiring the key id slot': p => {
    p.templates['ansiwise/templates/cluster-map.tpl'] = p.templates['ansiwise/templates/cluster-map.tpl'].replace('<acme-eab-key-id?>', '<acme-eab-key-id>');
  },
  'the cluster map filling acmeEabKeyId from another answer': p => {
    const row = p.programs['deploy-branch'].find(r => r.template === 'ansiwise/templates/cluster-map.tpl');
    for (const from of Object.values(row.values)) if (from.answer === 'acme_eab_key_id') from.answer = 'letsencrypt_server';
  },
  'the key id answer required': p => { p.answers['deploy-platform-services'].find(a => a.name === 'acme_eab_key_id').required = true; },
  'the key id answer missing from deploy-branch': p => { p.answers['deploy-branch'] = p.answers['deploy-branch'].filter(a => a.name !== 'acme_eab_key_id'); },
  'the MAC key answer not secret': p => { delete p.answers['deploy-branch'].find(a => a.name === 'acme_eab_mac_key').secret; },
  'the MAC key never filled into the credentials file': p => {
    for (const row of p.programs['deploy-branch']) if (row.values?.ACME_EAB_MAC_KEY) delete row.values.ACME_EAB_MAC_KEY;
  },
  'a seed row outside [secret_store_enabled, books_here_in_answers]': p => {
    p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-eab').when = ['secret_store_enabled'];
  },
  'the account key seeded on every cluster': p => {
    p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-account').when = ['secret_store_enabled'];
  },
  'the MAC key required in Vault': p => { delete p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-eab').optional_fields; },
  'the MAC key minted': p => { p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-eab').mint = ['mac-key']; },
  'the account key in other fields': p => { p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-account').private_key_field = 'tls.key'; },
  'the account key pair publishing the mail key\'s name': p => { delete p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-account').publish; },
  'the account key seeded twice': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.push(structuredClone(rows.find(r => r.path === '<stage>/app/acme-account')));
  },
  'the account wait before the seeds, as at bb1976d': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, accountWait), 1);
    rows.splice(at(rows, r => r.step === 'trust_cluster_authority') + 1, 0, row);
  },
  'the account wait between the seeds and the handoff': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, accountWait), 1);
    rows.splice(at(rows, r => r.path === '<stage>/app/acme-eab') + 1, 0, row);
  },
  'the account wait given its old 60 seconds': p => { p.programs['deploy-platform-services'].find(accountWait).timeout_seconds = 60; },
  'the account wait gone': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, accountWait), 1);
  },
  'the directory row admitting every production directory, as before': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = '^https://(?![^/]*staging)[^/]+/[^\\s]*$';
  },
  'the directory row admitting the GTS test directory': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = '^https://dv\\.acme-v02\\.(test-)?api\\.pki\\.goog/directory$';
  },
  'the directory row without its end anchor': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = '^https://dv\\.acme-v02\\.api\\.pki\\.goog/directory';
  },
  'the directory row without its start anchor': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = 'https://dv\\.acme-v02\\.api\\.pki\\.goog/directory$';
  },
  'the directory row judging another answer': p => { p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').answer = 'letsencrypt_email'; },
  'the directory row gone': p => {
    const rows = p.programs['deploy-cluster'];
    rows.splice(at(rows, r => r.answer === 'letsencrypt_server'), 1);
  },
  'the directory row after the addons are enabled': p => {
    const rows = p.programs['deploy-cluster'];
    const [row] = rows.splice(at(rows, r => r.answer === 'letsencrypt_server'), 1);
    rows.splice(at(rows, r => r.step === 'enable_addons') + 1, 0, row);
  },
  'the issuers\' probe reading the values a dry run never wrote': p => {
    const row = p.programs['deploy-platform-services'].find(valuesProbe('cert-manager-issuers'));
    row.command_arguments[1] = row.command_arguments[1].replace(DRY_GUARD, '');
  },
  'the Bundle\'s probe asking after another file': p => {
    const row = p.programs['deploy-platform-services'].find(valuesProbe('trust-manager-bundles'));
    row.command_arguments[1] = row.command_arguments[1].replace(`test -r ${RUN_VALUES}`, 'test -r /tmp/other.yaml');
  },
  'the values written without ending a run that cannot write them': p => {
    p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES).on_failure = 'continue';
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
  'the two account seeds in the other order': p => {
    const rows = p.programs['deploy-platform-services'];
    const eab = at(rows, r => r.path === '<stage>/app/acme-eab');
    const account = at(rows, r => r.path === '<stage>/app/acme-account');
    [rows[eab], rows[account]] = [rows[account], rows[eab]];
  },
  'the account key pair publishing a name of its own choosing': p => {
    p.programs['deploy-platform-services'].find(r => r.path === '<stage>/app/acme-account').publish = {dkim_public_key: 'another_public_key'};
  },
  'the key id slots under another name': p => {
    const map = p.programs['deploy-branch'].find(r => r.template === 'ansiwise/templates/cluster-map.tpl');
    const values = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    for (const row of [map, values]) {
      p.templates[row.template] = p.templates[row.template].replace('<acme-eab-key-id?>', '<eab-key-id?>');
      row.values['eab-key-id'] = row.values['acme-eab-key-id'];
      delete row.values['acme-eab-key-id'];
    }
  },
  'the account wait as the last row': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, accountWait), 1);
    rows.push(row);
  },
  'the directory row with its dots written as classes': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = '^https://dv[.]acme-v02[.]api[.]pki[.]goog/directory$';
  },
  'the directory row anchored around a group': p => {
    p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').pattern = '^(?:https://dv\\.acme-v02\\.api\\.pki\\.goog/directory)$';
  },
  'the directory row refusing in other words': p => { p.programs['deploy-cluster'].find(r => r.answer === 'letsencrypt_server').refusal = 'answer the GTS directory'; },
  'the probe saying in other words why a dry run cannot measure': p => {
    const row = p.programs['deploy-platform-services'].find(valuesProbe('cert-manager-issuers'));
    row.command_arguments[1] = row.command_arguments[1].replace(/echo "[^"]+"/, 'echo "no values file yet"');
  },
  'the account wait given longer': p => { p.programs['deploy-platform-services'].find(accountWait).timeout_seconds = 900; },
  'the values template keys in another order': p => {
    const row = p.programs['deploy-platform-services'].find(r => r.path === RUN_VALUES && same(r.when, ['certificates_enabled']));
    const keys = p.templates[row.template].split('\n').filter(l => /^ {2}\w/.test(l));
    p.templates[row.template] = `global:\n${keys.reverse().join('\n')}\n`;
  },
};

test('PLANTED DEFECT: each way back is found, and the programs as built are not', () => {
  for (const [name, plant] of Object.entries(PLANTED)) {
    const planted = structuredClone({programs, conditions, templates, answers});
    plant(planted);
    assert.notDeepEqual(findings(planted), [], name);
  }
});

test('PLANTED INNOCENT: what the rule does not forbid stays green', () => {
  for (const [name, plant] of Object.entries(INNOCENT)) {
    const planted = structuredClone({programs, conditions, templates, answers});
    plant(planted);
    assert.deepEqual(findings(planted), [], name);
  }
});
