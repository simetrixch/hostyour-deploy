import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// What Forgejo on the master is handed. The identity provider's client secret for it is minted once,
// in <stage>/idp/bootstrap, beside every other client's; the provider's pods read it as
// IDP_FORGEJO_CLIENT_SECRET; Forgejo reads its own copy from <stage>/app/forgejo, written FROM the
// minted value by one row and never minted again. deploy-branch writes installation/values/forgejo.yaml
// with this installation's address, the SSH port it announces and its one sign-in source.
const LEAF = '<stage>/app/forgejo';
const at = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = file => JSON.parse(execFileSync('yq', ['-o=json', '.', at(file)], {encoding: 'utf8'}));
const services = read('ansiwise/programs/deploy-platform-services.yaml');
const branch = read('ansiwise/programs/deploy-branch.yaml');
const templateText = readFileSync(at('ansiwise/templates/forgejo-values.tpl'), 'utf8');

/** Every way deploy-platform-services breaks the rule, named. */
function secretFindings(steps) {
  const found = [];
  const bootstrap = steps.find(step => step.step === 'vault_kv_entry' && step.path === '<stage>/idp/bootstrap');
  if (!bootstrap?.fields.includes('forgejo-client-secret=IDP_FORGEJO_CLIENT_SECRET') || !bootstrap?.mint.includes('forgejo-client-secret')) found.push('the bootstrap entry does not mint forgejo-client-secret');
  const provider = steps.find(step => step.step === 'kubernetes_secret_from_vault' && step.name === 'idp-bootstrap-secrets');
  if (!provider?.fields.includes('IDP_FORGEJO_CLIENT_SECRET=forgejo-client-secret')) found.push('idp-bootstrap-secrets does not carry IDP_FORGEJO_CLIENT_SECRET');
  const rows = steps.filter(step => step.step === 'vault_kv_entry' && step.path === LEAF);
  if (rows.length !== 1) return [...found, `${rows.length} rows write ${LEAF}, not 1`];
  const [row] = rows;
  if (JSON.stringify(row.copy_from) !== JSON.stringify(['oidc-client-secret=<stage>/idp/bootstrap:forgejo-client-secret'])) found.push(`${LEAF} is not written from the bootstrap entry's forgejo-client-secret`);
  if ((row.mint ?? []).length > 0) found.push(`${LEAF} mints, so a value there is not the one the provider holds`);
  if (!['secret_store_enabled', 'idp_enabled', 'books_here_in_answers'].every(when => (row.when ?? []).includes(when))) found.push(`${LEAF} is written where no identity provider or no books are`);
  return found;
}

/** The template with its slots filled the way write_file_from_template fills them. */
const fill = (text, values) => Object.entries(values).reduce((out, [slot, value]) => out.replaceAll(`<${slot}>`, value), text);

/** Every way deploy-branch breaks the rule, named. */
function valuesFindings(program, text) {
  const found = [];
  const answer = program.answers.find(a => a.name === 'forgejo_ssh_port');
  if (String(answer?.default) !== '2222') found.push(`forgejo_ssh_port defaults to ${answer?.default}, not the port the master listens on`);
  const rows = program.steps.filter(step => step.step === 'write_file_from_template' && step.path === '/srv/hostyour-cloud/installation/values/forgejo.yaml');
  if (rows.length !== 1) return [...found, `${rows.length} rows write installation/values/forgejo.yaml, not 1`];
  const [row] = rows;
  if (row.template !== 'ansiwise/templates/forgejo-values.tpl' || row.file_mode !== 420) found.push('the file is not written from forgejo-values.tpl at mode 420');
  if (JSON.stringify(row.values) !== JSON.stringify({fqdn: {answer: 'fqdn'}, 'forgejo-ssh-port': {answer: 'forgejo_ssh_port'}})) found.push(`the slots are filled from ${JSON.stringify(row.values)}`);
  const filled = fill(text, {fqdn: 'planted.example', 'forgejo-ssh-port': '23'});
  const unfilled = filled.split('\n').filter(line => !line.trimStart().startsWith('#') && /<[a-z-]+>/.test(line));
  if (unfilled.length > 0) found.push(`slots no answer fills: ${unfilled.join(' | ')}`);
  const forgejo = JSON.parse(execFileSync('yq', ['-o=json', '.forgejo.gitea', '-'], {input: filled, encoding: 'utf8'}));
  const server = forgejo?.config?.server ?? {};
  if (server.DOMAIN !== 'forgejo.planted.example' || server.SSH_DOMAIN !== 'forgejo.planted.example' || server.ROOT_URL !== 'https://forgejo.planted.example/') found.push(`Forgejo is told it stands at ${server.DOMAIN}, ${server.SSH_DOMAIN}, ${server.ROOT_URL}`);
  if (server.SSH_PORT !== 23) found.push(`Forgejo announces SSH port ${server.SSH_PORT}`);
  const expected = [{name: 'authentik', provider: 'openidConnect', existingSecret: 'forgejo-oauth',
    autoDiscoverUrl: 'https://idp.planted.example/application/o/forgejo/.well-known/openid-configuration',
    scopes: 'openid email profile groups', groupClaimName: 'groups', adminGroup: 'admins'}];
  if (JSON.stringify(forgejo?.oauth) !== JSON.stringify(expected)) found.push(`the sign-in list is ${JSON.stringify(forgejo?.oauth)}`);
  return found;
}

test('the Forgejo client secret is minted once and copied to Forgejo\'s own entry by one row', () => {
  assert.deepEqual(secretFindings(services.steps), []);
});

test('installation/values/forgejo.yaml carries the address, the announced SSH port and the one sign-in source', () => {
  assert.deepEqual(valuesFindings(branch, templateText), []);
});

test('PLANTED DEFECT: a second row on the entry, a mint there, a missing bootstrap mint and a missing provider key are found', () => {
  const planted = {
    'a second row erases the first': steps => { steps.push({...steps.find(s => s.path === LEAF), fields: ['planted=PLANTED'], copy_from: undefined}); },
    'the entry mints its own client secret': steps => { steps.find(s => s.path === LEAF).mint = ['oidc-client-secret']; },
    'the bootstrap entry does not mint it': steps => { const b = steps.find(s => s.path === '<stage>/idp/bootstrap'); b.mint = b.mint.filter(f => f !== 'forgejo-client-secret'); },
    'the provider never sees it': steps => { const p = steps.find(s => s.name === 'idp-bootstrap-secrets'); p.fields = p.fields.filter(f => !f.startsWith('IDP_FORGEJO')); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const steps = structuredClone(services.steps);
    plant(steps);
    assert.notDeepEqual(secretFindings(steps), [], name);
  }
});

test('PLANTED DEFECT: a slot no answer fills, a sign-in source without its admin group, and the listen port announced are found', () => {
  assert.notDeepEqual(valuesFindings(branch, templateText.replace('SSH_PORT: <forgejo-ssh-port>', 'SSH_PORT: <ssh-port>')), []);
  assert.notDeepEqual(valuesFindings(branch, templateText.replace(/\n\s*adminGroup: admins/, '')), []);
  const announcing2222 = structuredClone(branch);
  announcing2222.steps.find(s => s.path?.endsWith('/forgejo.yaml')).values['forgejo-ssh-port'] = {answer: 'planted'};
  assert.notDeepEqual(valuesFindings(announcing2222, templateText), []);
});

test('PLANTED INNOCENT: another comment in the template and the rows in another order are not found', () => {
  assert.deepEqual(valuesFindings(branch, `# planted comment naming <nothing>\n${templateText}`), []);
  assert.deepEqual(secretFindings([...services.steps].reverse()), []);
});
