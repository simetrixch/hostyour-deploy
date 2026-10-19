import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync, readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The Manager's second Cloudflare token, the one with Zone Settings Edit, travels from the installation
// answer cloudflare_zone_settings_api_token into the credentials file and from there into Vault
// <stage>/app/cloudflare-zone-settings, where the ExternalSecret of the Manager chart (hostyour-cloud)
// reads it through <cluster>-eso. It has an entry of its own beside the DNS token, so neither field can
// fail the other's sync, and no program but these two names it. Optional all the way: the Manager answers
// a proxied write without it by naming the variable, so a run before the owner's entry still passes.
const root = fileURLToPath(new URL('..', import.meta.url));
const programs = `${root}ansiwise/programs`;
const yq = (expression, program) => JSON.parse(execFileSync('yq', ['-o=json', expression, `${programs}/${program}.yaml`], {encoding: 'utf8'}));
const input = {
  answers: yq('.answers // []', 'deploy-branch'),
  branch: yq('.steps', 'deploy-branch'),
  services: yq('.steps', 'deploy-platform-services'),
  texts: Object.fromEntries(readdirSync(programs).filter(file => file.endsWith('.yaml')).map(file => [file.replace(/\.yaml$/, ''), readFileSync(`${programs}/${file}`, 'utf8')])),
};

const ANSWER = 'cloudflare_zone_settings_api_token';
const VARIABLE = 'CLOUDFLARE_ZONE_SETTINGS_API_TOKEN';
const PATH = '<stage>/app/cloudflare-zone-settings';
const DNS_PATH = '<stage>/app/cloudflare-dns';
const DNS_VARIABLE = 'CLOUDFLARE_DNS_API_TOKEN';
const CREDENTIALS = '/srv/hostyour-cloud/secrets/secrets.<stage>';
const SEED_WHEN = ['secret_store_enabled', 'books_here_in_answers'];
const READ_BY_ESO = 'path "secret/data/<stage>/app/*" { capabilities = ["read"] }';
const HOLDERS = ['deploy-branch', 'deploy-platform-services'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every way the settings token misses its way from the answer to the clusters' reader, or reaches a reader it must not. */
function findings({answers, branch, services, texts}) {
  const found = [];
  const answer = answers.find(each => each.name === ANSWER);
  if (!answer) found.push(`deploy-branch declares no ${ANSWER}`);
  else if (answer.kind !== 'text' || answer.required !== false || answer.secret !== true || answer.default !== undefined)
    found.push(`deploy-branch declares ${ANSWER} as ${answer.kind}, required ${answer.required}, secret ${answer.secret}, default ${answer.default}`);

  const fills = branch.filter(row => row.step === 'fill_key_value_file' && row.values?.[VARIABLE] !== undefined);
  if (fills.length !== 1) found.push(`${fills.length} rows of deploy-branch fill ${VARIABLE}`);
  for (const row of fills) {
    if (!same(row.values[VARIABLE], {answer: ANSWER})) found.push(`deploy-branch fills ${VARIABLE} from ${JSON.stringify(row.values[VARIABLE])}`);
    if (row.path !== CREDENTIALS || row.holds_credentials !== true || row.when !== undefined) found.push(`deploy-branch fills ${VARIABLE} into ${row.path} under ${JSON.stringify(row.when)}`);
    if (!same(row.values[DNS_VARIABLE], {answer: 'cloudflare_dns_api_token'})) found.push(`deploy-branch fills ${DNS_VARIABLE} from ${JSON.stringify(row.values[DNS_VARIABLE])}`);
  }

  const rows = services.filter(row => row.path === PATH);
  if (rows.length !== 1) found.push(`${rows.length} rows of deploy-platform-services write ${PATH}`);
  for (const row of rows) {
    if (row.step !== 'vault_kv_entry' || !same(row.fields, [`api-token=${VARIABLE}`])) found.push(`${PATH} is written by ${row.step} with ${JSON.stringify(row.fields)}`);
    if (!same(row.optional_fields, ['api-token'])) found.push(`${PATH} is required, so every run of deploy-platform-services fails until the token is entered`);
    for (const key of ['mint', 'fields_from_answers', 'copy_from', 'fields_owned_elsewhere']) if (row[key] !== undefined) found.push(`${PATH} is written with ${key}`);
    if (!same(row.when, SEED_WHEN) || row.repository !== '/srv/hostyour-cloud' || row.mount !== 'secret' || row.rests_on_an_earlier_step !== true || row.on_failure !== 'exit') found.push(`${PATH} is seeded unlike the installation's other seeds`);
  }
  const dns = services.filter(row => row.path === DNS_PATH);
  if (dns.length !== 1 || !same(dns[0].fields, [`api-token=${DNS_VARIABLE}`])) found.push(`${DNS_PATH} does not carry ${DNS_VARIABLE} alone`);

  const eso = services.filter(row => row.step === 'vault_policy' && row.name === '<cluster>-eso');
  if (eso.length !== 1 || !String(eso[0].rules).split('\n').map(line => line.trim()).includes(READ_BY_ESO)) found.push(`the clusters' secret reader <cluster>-eso cannot read ${PATH}`);

  for (const [program, text] of Object.entries(texts))
    if (!HOLDERS.includes(program) && (text.includes(VARIABLE) || text.includes(ANSWER) || text.includes('cloudflare-zone-settings'))) found.push(`the program ${program} names the settings token, which only the Manager reads`);
  return found;
}

test('the settings token goes from its optional answer to the Vault entry of its own, and reaches no other program', () => {
  assert.deepEqual(findings(input), []);
});

test('PLANTED DEFECT: each break of the way is found, and the programs as they are are not', () => {
  const vaultRow = p => p.services.find(row => row.path === PATH);
  const planted = {
    'the Vault row is missing': p => { p.services.splice(p.services.indexOf(vaultRow(p)), 1); },
    'the answer is required': p => { p.answers.find(a => a.name === ANSWER).required = true; },
    'the answer is not secret': p => { delete p.answers.find(a => a.name === ANSWER).secret; },
    'the answer is gone': p => { p.answers.splice(p.answers.findIndex(a => a.name === ANSWER), 1); },
    'the binding is gone': p => { delete p.branch.find(row => row.values?.[VARIABLE]).values[VARIABLE]; },
    'the binding reads the DNS answer': p => { p.branch.find(row => row.values?.[VARIABLE]).values[VARIABLE] = {answer: 'cloudflare_dns_api_token'}; },
    'the field is required': p => { delete vaultRow(p).optional_fields; },
    'the field reads another variable': p => { vaultRow(p).fields = [`api-token=${DNS_VARIABLE}`]; },
    'the DNS entry carries the settings field': p => { p.services.find(row => row.path === DNS_PATH).fields.push(`settings-token=${VARIABLE}`); },
    'the settings entry carries the DNS field': p => { vaultRow(p).fields.push(`dns-token=${DNS_VARIABLE}`); },
    'the clusters cannot read it': p => { p.services.find(row => row.name === '<cluster>-eso').rules = 'path "secret/data/<stage>/slaves/*" { capabilities = ["read"] }'; },
    'the publish-mail program reads it': p => { p.texts['publish-mail-dns'] += `\n  token_variable: ${VARIABLE}\n`; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const copy = structuredClone(input);
    plant(copy);
    assert.notDeepEqual(findings(copy), [], name);
  }
  assert.deepEqual(findings(structuredClone(input)), [], 'the planted innocent: the programs as they are');
});

test('PLANTED INNOCENT: an empty answer passes the seed, because the field is optional', () => {
  const row = input.services.find(each => each.path === PATH);
  assert.deepEqual(row.optional_fields, ['api-token']);
  const required = structuredClone(input);
  delete required.services.find(each => each.path === PATH).optional_fields;
  assert.deepEqual(findings(required), [`${PATH} is required, so every run of deploy-platform-services fails until the token is entered`]);
});
