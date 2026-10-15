import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The CA of the installation's own Cloudflare origin pull client certificate travels from the
// installation answer cloudflare_origin_pull_ca into the credentials file and from there into Vault
// <stage>/app/cloudflare-origin-pull, where ExternalSecret cloudflare-origin-pull-ca of every
// cluster (hostyour-cloud) reads it through <cluster>-eso. Optional all the way: an installation that
// serves no host behind Cloudflare's proxy answers nothing and writes nothing. Only the public CA
// certificate takes this way; the client certificate and its key stay in the owner's config.
const root = fileURLToPath(new URL('..', import.meta.url));
const yq = (expression, program) => JSON.parse(execFileSync('yq', ['-o=json', expression, `${root}ansiwise/programs/${program}.yaml`], {encoding: 'utf8'}));
const input = {
  answers: yq('.answers // []', 'deploy-branch'),
  branch: yq('.steps', 'deploy-branch'),
  services: yq('.steps', 'deploy-platform-services'),
};

const ANSWER = 'cloudflare_origin_pull_ca';
const VARIABLE = 'CLOUDFLARE_ORIGIN_PULL_CA';
const PATH = '<stage>/app/cloudflare-origin-pull';
const CREDENTIALS = '/srv/hostyour-cloud/secrets/secrets.<stage>';
const SEED_WHEN = ['secret_store_enabled', 'books_here_in_answers'];
const READ_BY_ESO = 'path "secret/data/<stage>/app/*" { capabilities = ["read"] }';
const CLIENT_HALF = /ORIGIN_PULL_(CERTIFICATE|PRIVATE_KEY)|origin_pull_(certificate|private_key)/;
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every way the CA misses its way from the answer to the clusters' reader, or takes the client half along. */
function findings({answers, branch, services}) {
  const found = [];
  const answer = answers.find(each => each.name === ANSWER);
  if (!answer) found.push(`deploy-branch declares no ${ANSWER}`);
  else if (answer.kind !== 'text' || answer.required !== false || answer.default !== undefined) found.push(`deploy-branch declares ${ANSWER} as ${answer.kind}, required ${answer.required}, default ${answer.default}`);

  const fills = branch.filter(row => row.step === 'fill_key_value_file' && row.values?.[VARIABLE] !== undefined);
  if (fills.length !== 1) found.push(`${fills.length} rows of deploy-branch fill ${VARIABLE}`);
  for (const row of fills) {
    if (!same(row.values[VARIABLE], {answer: ANSWER})) found.push(`deploy-branch fills ${VARIABLE} from ${JSON.stringify(row.values[VARIABLE])}`);
    if (row.path !== CREDENTIALS || row.holds_credentials !== true || row.when !== undefined) found.push(`deploy-branch fills ${VARIABLE} into ${row.path} under ${JSON.stringify(row.when)}`);
  }

  const rows = services.filter(row => row.path === PATH);
  if (rows.length !== 1) found.push(`${rows.length} rows of deploy-platform-services write ${PATH}`);
  for (const row of rows) {
    if (row.step !== 'vault_kv_entry' || !same(row.fields, [`ca-certificate=${VARIABLE}`])) found.push(`${PATH} is written by ${row.step} with ${JSON.stringify(row.fields)}`);
    if (!same(row.optional_fields, ['ca-certificate'])) found.push(`${PATH} is required, so an installation without a proxied host is refused`);
    for (const key of ['mint', 'fields_from_answers', 'copy_from', 'fields_owned_elsewhere']) if (row[key] !== undefined) found.push(`${PATH} is written with ${key}`);
    if (!same(row.when, SEED_WHEN) || row.repository !== '/srv/hostyour-cloud' || row.mount !== 'secret' || row.rests_on_an_earlier_step !== true || row.on_failure !== 'exit') found.push(`${PATH} is seeded unlike the installation's other seeds`);
  }
  const eso = services.filter(row => row.step === 'vault_policy' && row.name === '<cluster>-eso');
  if (eso.length !== 1 || !String(eso[0].rules).split('\n').map(line => line.trim()).includes(READ_BY_ESO)) found.push(`the clusters' secret reader <cluster>-eso cannot read ${PATH}`);

  if (CLIENT_HALF.test(JSON.stringify({answers, branch, services}))) found.push('the client certificate or its key enters a program');
  return found;
}

test('the origin pull CA goes from its optional answer to the Vault entry every cluster reads, and nothing else does', () => {
  assert.deepEqual(findings(input), []);
});

test('PLANTED DEFECT: each break of the way is found, and the programs as they are are not', () => {
  const vaultRow = p => p.services.find(row => row.path === PATH);
  const planted = {
    'the Vault row is missing': p => { p.services.splice(p.services.indexOf(vaultRow(p)), 1); },
    'the answer is required': p => { p.answers.find(a => a.name === ANSWER).required = true; },
    'the answer is gone': p => { p.answers.splice(p.answers.findIndex(a => a.name === ANSWER), 1); },
    'the binding is gone': p => { delete p.branch.find(row => row.values?.[VARIABLE]).values[VARIABLE]; },
    'the field is required': p => { delete vaultRow(p).optional_fields; },
    'the field reads another variable': p => { vaultRow(p).fields = ['ca-certificate=CLOUDFLARE_DNS_API_TOKEN']; },
    'the client key rides along': p => { vaultRow(p).fields.push('private-key=CLOUDFLARE_ORIGIN_PULL_PRIVATE_KEY'); },
    'the clusters cannot read it': p => { p.services.find(row => row.name === '<cluster>-eso').rules = 'path "secret/data/<stage>/slaves/*" { capabilities = ["read"] }'; },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const copy = structuredClone(input);
    plant(copy);
    assert.notDeepEqual(findings(copy), [], name);
  }
  assert.deepEqual(findings(structuredClone(input)), [], 'the planted innocent: the programs as they are');
});
