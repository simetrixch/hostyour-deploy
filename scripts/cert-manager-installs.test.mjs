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
// there, says why it cannot measure instead of printing helm's refusal of the missing file. The
// probe answers 0 there, and the engine records the output of a command that answered 0 only where
// its row says keep_output: without it the sentence reaches no record.
const DRY_GUARD = new RegExp(`^test -r ${RUN_VALUES.replace(/\./g, '\\.')} \\|\\| \\{ echo "[^"]+"; exit 0; \\}; `);
// Each install, the values it is given, and the one object whose absence lets it run.
const INSTALLS = {
  'cert-manager': {values: `${INVENTORY}/cert-manager/values-common.yaml`, absent: [['deployment', 'cert-manager', 'cert-manager']]},
  'cert-manager-issuers': {values: RUN_VALUES, absent: [['clusterissuer', 'platform-acme'], ['clusterissuer', 'platform-local']]},
  'trust-manager': {values: `${INVENTORY}/trust-manager/values-common.yaml`, absent: [['deployment', 'trust-manager', 'cert-manager']]},
  'trust-manager-bundles': {values: RUN_VALUES, absent: [['bundle', 'platform-trust']]},
};
const ISSUER_SWITCH = {'platform-acme': 'certificates_enabled', 'platform-local': 'certificates_withheld'};
// The run's values are the cluster's map as committed, the file Argo CD renders both charts from, so
// a key a chart asks for is the map producer's to write and no copy of the zones stands in the program.
const MAP_COPY = {
  step: 'copy_branch_file',
  repository: '/srv/hostyour-cloud',
  path: 'clusters/active/<fqdn>.yaml',
  run_answer: 'fqdn',
  destination: RUN_VALUES,
  file_mode: 420,
  on_failure: 'exit',
};
const MAP_TEMPLATE = 'ansiwise/templates/cluster-map.tpl';
const MAP_KEYS = ['global.clusterIssuer', 'global.platformDomain', 'global.unitApex', 'global.letsencryptEmail', 'global.letsencryptServer', 'global.acmeEabKeyId'];

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

  // ONE VALUES FILE FOR BOTH ISSUERS, AND IT IS THE MAP. The row copies the committed bytes, under no
  // condition, because the admission waits read the file on every run, and nothing else may write it.
  const writers = steps.flatMap((row, i) => row.path === RUN_VALUES || row.destination === RUN_VALUES ? [[i, row]] : []);
  const copies = writers.filter(([, row]) => row.step === 'copy_branch_file');
  if (copies.length !== 1) found.push(`${copies.length} rows copy the cluster's map to ${RUN_VALUES}`);
  const readers = steps.flatMap((row, j) => JSON.stringify(row).includes(RUN_VALUES) && !writers.some(([, w]) => w === row) ? [j] : []);
  for (const [i, row] of writers) {
    const where = `deploy-platform-services[${i}] the run's values`;
    if (row.step !== 'copy_branch_file') {
      found.push(`${where} are written by ${row.step}, not copied from the cluster's map`);
      continue;
    }
    for (const [key, value] of Object.entries(MAP_COPY)) {
      if (!same(row[key], value)) found.push(`${where} are copied with ${key} ${JSON.stringify(row[key])}`);
    }
    for (const key of Object.keys(row)) {
      if (!(key in MAP_COPY)) found.push(`${where} are copied with ${key} ${JSON.stringify(row[key])}`);
    }
    if (readers.some(j => j < i)) found.push(`${where} are copied after a row reads them`);
  }

  for (const [program, rows] of Object.entries(programs)) {
    rows.forEach((row, i) => {
      if (row.step !== 'wait_for_command_output' || !JSON.stringify(row).includes(RUN_VALUES)) return;
      const [flag, script] = row.command_arguments ?? [];
      if (row.command !== 'sh' || flag !== '-c' || !DRY_GUARD.test(script ?? '')) found.push(`${program}[${i}] reads ${RUN_VALUES} where a dry run wrote none`);
      if (row.keep_output !== true) found.push(`${program}[${i}] says why a dry run cannot measure where no record keeps it`);
    });
  }

  const trust = steps.findIndex(row => row.step === 'trust_cluster_authority');
  const unseal = steps.findIndex(row => row.step === 'vault_init');
  if (trust < 0) found.push('deploy-platform-services does not trust the cluster authority');
  else {
    if (!(steps[trust].when ?? []).includes('certificates_withheld')) found.push('trust_cluster_authority runs without certificates_withheld');
    if (unseal >= 0 && trust > unseal) found.push('trust_cluster_authority stands after vault_init');
  }
  return [...found, ...mapFindings({templates}), ...accountFindings({programs, templates, answers}), ...directoryFindings({programs})];
}

/** Every key the two charts ask for that the cluster map's template does not write under global. */
function mapFindings({templates}) {
  let map;
  try {
    map = yq(['.'], (templates[MAP_TEMPLATE] ?? '').replace(/<([a-z-]+)[?!]*>/g, '__$1__'));
  } catch {
    return [`${MAP_TEMPLATE} is no YAML`];
  }
  const held = leaves(map ?? {}).map(([key]) => key);
  return MAP_KEYS.filter(key => !held.includes(key)).map(key => `the cluster map writes no ${key}`);
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
// from it and deploy-platform-services renders the issuers it installs itself. Its MAC key is a
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

  const branch = programs['deploy-branch'] ?? [];
  const map = branch.find(row => row.step === 'write_file_from_template' && row.template === MAP_TEMPLATE);
  const mapLine = /^ {2}acmeEabKeyId: <([a-z-]+)(\??)>$/m.exec(templates[MAP_TEMPLATE] ?? '');
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
    // Only the books cluster delivers the account in this run; a slave's comes after register-slave.
    if (!(services[i].when ?? []).includes('books_here_in_answers')) found.push(`deploy-platform-services[${i}] waits for platform-acme on a slave, whose account arrives after register-slave`);
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
const copiesTheMap = r => r.step === 'copy_branch_file' && r.destination === RUN_VALUES;
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
  'the issuers\' values written from a template again': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, copiesTheMap)] = {step: 'write_file_from_template', template: MAP_TEMPLATE, path: RUN_VALUES, file_mode: 420, on_failure: 'exit'};
  },
  'the issuers\' values copied from another path': p => { p.programs['deploy-platform-services'].find(copiesTheMap).path = 'clusters/platform/values-common.yaml'; },
  'the issuers\' values copied from another checkout': p => { p.programs['deploy-platform-services'].find(copiesTheMap).repository = '/srv/ansiwise-programs'; },
  'the issuers\' values copied for the public authority only': p => { p.programs['deploy-platform-services'].find(copiesTheMap).when = ['certificates_enabled']; },
  'the issuers\' values copied by no row': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, copiesTheMap), 1);
  },
  'the issuers\' values copied after the issuers\' probe': p => {
    const rows = p.programs['deploy-platform-services'];
    const [row] = rows.splice(at(rows, copiesTheMap), 1);
    rows.splice(at(rows, valuesProbe('cert-manager-issuers')) + 1, 0, row);
  },
  'the issuers\' values overwritten by a template after the copy': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, copiesTheMap) + 1, 0, {step: 'write_file_from_template', template: MAP_TEMPLATE, path: RUN_VALUES, file_mode: 420, on_failure: 'exit'});
  },
  'the issuers\' values copied without ending a run that cannot copy them': p => { p.programs['deploy-platform-services'].find(copiesTheMap).on_failure = 'continue'; },
  'the issuers given a values file of their own': p => {
    for (const row of p.programs['deploy-platform-services'].filter(release('cert-manager-issuers'))) row.values = `${INVENTORY}/cert-manager-issuers/values-common.yaml`;
  },
  ...Object.fromEntries(MAP_KEYS.map(key => [`the cluster map without ${key}`, p => {
    p.templates[MAP_TEMPLATE] = p.templates[MAP_TEMPLATE].split('\n').filter(l => !l.startsWith(`  ${key.split('.')[1]}:`)).join('\n');
  }])),
  'the cluster map with the zone of the units outside global': p => {
    p.templates[MAP_TEMPLATE] = `${p.templates[MAP_TEMPLATE].split('\n').filter(l => !l.startsWith('  unitApex:')).join('\n')}unitApex: <unit-apex>\n`;
  },
  'trust_cluster_authority gone': p => {
    const rows = p.programs['deploy-platform-services'];
    rows.splice(at(rows, r => r.step === 'trust_cluster_authority'), 1);
  },
  'trust_cluster_authority on every cluster': p => {
    const rows = p.programs['deploy-platform-services'];
    rows[at(rows, r => r.step === 'trust_cluster_authority')].when = [];
  },
  'the acmeEabKeyId line missing from the cluster map where the answer is given': p => {
    p.templates[MAP_TEMPLATE] = p.templates[MAP_TEMPLATE].split('\n').filter(l => !l.includes('acmeEabKeyId')).join('\n');
  },
  'the cluster map requiring the key id slot': p => {
    p.templates[MAP_TEMPLATE] = p.templates[MAP_TEMPLATE].replace('<acme-eab-key-id?>', '<acme-eab-key-id>');
  },
  'the cluster map filling acmeEabKeyId from another answer': p => {
    const row = p.programs['deploy-branch'].find(r => r.template === MAP_TEMPLATE);
    for (const from of Object.values(row.values)) if (from.answer === 'acme_eab_key_id') from.answer = 'letsencrypt_server';
  },
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
  'the Bundle\'s probe whose reason no record keeps': p => {
    delete p.programs['deploy-platform-services'].find(valuesProbe('trust-manager-bundles')).keep_output;
  },
  'the account wait on a slave': p => {
    const row = p.programs['deploy-platform-services'].find(accountWait);
    row.when = row.when.filter(w => w !== 'books_here_in_answers');
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
  'the key id slot under another name': p => {
    const map = p.programs['deploy-branch'].find(r => r.template === MAP_TEMPLATE);
    p.templates[MAP_TEMPLATE] = p.templates[MAP_TEMPLATE].replace('<acme-eab-key-id?>', '<eab-key-id?>');
    map.values['eab-key-id'] = map.values['acme-eab-key-id'];
    delete map.values['acme-eab-key-id'];
  },
  'the cluster map of a cluster whose issuer is platform-local': p => {
    p.templates[MAP_TEMPLATE] = p.templates[MAP_TEMPLATE].replace('clusterIssuer: <cluster-issuer>', 'clusterIssuer: platform-local');
    delete p.programs['deploy-branch'].find(r => r.template === MAP_TEMPLATE).values['cluster-issuer'];
  },
  'the zones written in the other order': p => {
    const lines = p.templates[MAP_TEMPLATE].split('\n');
    const [unit, domain] = ['  unitApex:', '  platformDomain:'].map(start => lines.findIndex(l => l.startsWith(start)));
    [lines[unit], lines[domain]] = [lines[domain], lines[unit]];
    p.templates[MAP_TEMPLATE] = lines.join('\n');
  },
  'the copy row with its keys in another order': p => {
    const rows = p.programs['deploy-platform-services'];
    const at = rows.findIndex(copiesTheMap);
    rows[at] = Object.fromEntries(Object.entries(rows[at]).reverse());
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
  'a wait that reads no values file keeping its output too': p => {
    p.programs['deploy-platform-services'].find(r => r.step === 'wait_for_command_output' && !JSON.stringify(r).includes(RUN_VALUES)).keep_output = true;
  },
  'the account wait with its gates in the other order': p => { p.programs['deploy-platform-services'].find(accountWait).when.reverse(); },
  'the account wait given longer': p => { p.programs['deploy-platform-services'].find(accountWait).timeout_seconds = 900; },
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
