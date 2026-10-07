import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Argo CD's login reads its client secret through the cluster's secret reader from an entry in the
// application tier, <stage>/app/argocd, which this program writes FROM the one minted value in
// <stage>/idp/bootstrap and never mints again. No cluster's secret reader policy reaches the bootstrap
// entry itself, so no workload secret reader can access another workload's credentials or platform tokens.
const LEAF = '<stage>/app/argocd';
const TARGETS = ['secret/data/<stage>/idp/bootstrap', 'secret/data/prod/idp/bootstrap'];

// reaches is kept here because scripts/manager-post-client-read.test.mjs does not export it.
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
  if (JSON.stringify(row.copy_from) !== JSON.stringify(['client-secret=<stage>/idp/bootstrap:argocd-client-secret'])) {
    found.push(`${LEAF} is not copied from <stage>/idp/bootstrap:argocd-client-secret`);
  }
  if ((row.mint ?? []).length > 0) {
    found.push(`${LEAF} mints, so its value would not be the one the provider holds`);
  }
  if (!(row.when ?? []).includes('idp_enabled')) {
    found.push(`${LEAF} is written where no identity provider runs`);
  }
  const bootstrap = steps.find(step => step.step === 'vault_kv_entry' && step.path === '<stage>/idp/bootstrap');
  if (!bootstrap?.mint?.includes('argocd-client-secret')) {
    found.push('the bootstrap entry no longer mints argocd-client-secret, the one value');
  }

  const policyNames = new Set(['<cluster>-eso']);
  const readerRoles = steps.filter(step =>
    step.step === 'vault_auth_role' && (
      step.role === 'external-secrets' ||
      step.role.endsWith('-eso') ||
      step.role.includes('consumer')
    )
  );
  for (const roleStep of readerRoles) {
    const body = typeof roleStep.body === 'string' ? JSON.parse(roleStep.body) : roleStep.body;
    for (const name of body.token_policies ?? []) {
      policyNames.add(name);
    }
  }

  const policies = steps.filter(step => step.step === 'vault_policy' && policyNames.has(step.name));
  for (const policy of policies) {
    const globs = [...(policy.rules ?? '').matchAll(/path "([^"]+)"/g)].map(match => match[1]);
    const wide = globs.filter(glob => TARGETS.some(target => reaches(glob, target)));
    if (wide.length > 0) {
      found.push(`policy ${policy.name} reaches identity provider bootstrap: ${wide.join('; ')}`);
    }
  }

  return found;
}

test('no cluster secret reader reads the identity provider bootstrap entry', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: the removed policy line put back, a grant on the bootstrap entry, or a missing copy is found, and the program itself passes', () => {
  const at = rows => rows.find(row => row.step === 'vault_kv_entry' && row.path === LEAF);
  const esoPolicy = rows => rows.find(row => row.step === 'vault_policy' && row.name === '<cluster>-eso');
  const consumerPolicy = rows => rows.find(row => row.step === 'vault_policy' && row.name === '<cluster>-consumer-read');
  const planted = {
    'the removed line is put back in the eso policy': rows => {
      esoPolicy(rows).rules += '\npath "secret/data/<stage>/idp/bootstrap" { capabilities = ["read"] }';
    },
    'the eso policy reads prod idp bootstrap': rows => {
      esoPolicy(rows).rules += '\npath "secret/data/prod/idp/bootstrap" { capabilities = ["read"] }';
    },
    'the eso policy reads all stage secrets': rows => {
      esoPolicy(rows).rules += '\npath "secret/data/<stage>/*" { capabilities = ["read"] }';
    },
    'a consumer policy reads idp bootstrap': rows => {
      consumerPolicy(rows).rules += '\npath "secret/data/<stage>/idp/bootstrap" { capabilities = ["read"] }';
    },
    'the argocd entry mints': rows => {
      at(rows).mint = ['client-secret'];
    },
    'the argocd entry is not copied': rows => {
      delete at(rows).copy_from;
    },
    'the argocd entry copies wrong key': rows => {
      at(rows).copy_from = ['client-secret=<stage>/idp/bootstrap:other-secret'];
    },
    'no row writes the argocd entry': rows => {
      const i = rows.indexOf(at(rows));
      rows.splice(i, 1);
    },
    'duplicate row writes the argocd entry': rows => {
      rows.push(structuredClone(at(rows)));
    },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
});
