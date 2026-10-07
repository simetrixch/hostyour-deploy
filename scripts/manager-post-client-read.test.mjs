import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The Manager seeds the post client's secret into digita-post's own entry when it onboards a stage of
// post, instead of an operator copying it by hand. It reads the secret from an
// entry of its own, <stage>/idp/clients/post, which this program writes FROM the one minted value in
// <stage>/idp/bootstrap and never mints again; and both shapes of its policy read that entry and no
// other entry of the identity provider, so the Manager reads no other client's secret.
const LEAF = '<stage>/idp/clients/post';
const READ = `path "secret/data/${LEAF}" { capabilities = ["read"] }`;
// Paths of the identity provider the manager policy must not reach, beside the one leaf: its bootstrap
// entry with every client secret, another client's entry, and the same under a stage written out.
const PROVIDER = ['secret/data/<stage>/idp/bootstrap', 'secret/data/<stage>/idp/clients/argocd', 'secret/data/prod/idp/bootstrap'];

/** Whether a Vault policy path reaches `path`: `+` stands for one segment, a trailing `*` for any rest. */
function reaches(glob, path) {
  const body = glob.replace(/[.^$()|[\]{}\\?]/g, '\\$&').replace(/\+/g, '[^/]+').replace(/\*$/, '.*');
  return new RegExp(`^${body}$`).test(path);
}

const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-platform-services.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every way the program breaks the rule, named. */
function findings(steps) {
  const found = [];
  const rows = steps.filter(row => row.step === 'vault_kv_entry' && row.path === LEAF);
  if (rows.length !== 1) return [`${rows.length} rows write ${LEAF}, not 1`];
  const [row] = rows;
  if (JSON.stringify(row.copy_from) !== JSON.stringify(['client-secret=<stage>/idp/bootstrap:post-client-secret'])) found.push(`${LEAF} is not written from the bootstrap entry's post-client-secret`);
  if ((row.mint ?? []).length > 0) found.push(`${LEAF} mints, so its value would not be the one the provider holds`);
  if (!(row.when ?? []).includes('idp_enabled')) found.push(`${LEAF} is written where no identity provider runs`);
  const bootstrap = steps.find(step => step.step === 'vault_kv_entry' && step.path === '<stage>/idp/bootstrap');
  if (!bootstrap?.mint?.includes('post-client-secret')) found.push('the bootstrap entry no longer mints post-client-secret, the one value');
  const shapes = steps.filter(step => step.step === 'vault_policy' && step.name === 'manager');
  if (shapes.length !== 2) return [...found, `${shapes.length} shapes of the manager policy, not 2`];
  for (const [i, shape] of shapes.entries()) {
    if (!shape.rules.includes(READ)) found.push(`shape ${i + 1} does not read ${LEAF}`);
    const globs = [...shape.rules.matchAll(/path "([^"]+)"\s*\{\s*capabilities = \[[^\]]*"read"/g)].map(match => match[1]);
    const wide = globs.filter(glob => PROVIDER.some(path => reaches(glob, path)));
    if (wide.length > 0) found.push(`shape ${i + 1} reaches more of the identity provider: ${wide.join('; ')}`);
  }
  return found;
}

test('the Manager reads the post client secret from its own entry, written from the one minted value', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: a mint, a missing grant, a grant on the bootstrap entry, or a missing copy is found, and the program itself is not', () => {
  const at = rows => rows.find(row => row.step === 'vault_kv_entry' && row.path === LEAF);
  const shapes = rows => rows.filter(row => row.step === 'vault_policy' && row.name === 'manager');
  const planted = {
    'the leaf mints': rows => { at(rows).mint = ['client-secret']; },
    'the leaf is not copied': rows => { delete at(rows).copy_from; },
    'shape 2 does not read the leaf': rows => { const s = shapes(rows)[1]; s.rules = s.rules.replace(READ, ''); },
    'shape 1 reads the whole bootstrap entry': rows => { const s = shapes(rows)[0]; s.rules += '\npath "secret/data/<stage>/idp/bootstrap" { capabilities = ["read"] }'; },
    'shape 1 reads the whole stage, the provider with it': rows => { const s = shapes(rows)[0]; s.rules += '\npath "secret/data/<stage>/*" { capabilities = ["read"] }'; },
    'no row writes the leaf': rows => { const i = rows.indexOf(at(rows)); rows.splice(i, 1); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});
