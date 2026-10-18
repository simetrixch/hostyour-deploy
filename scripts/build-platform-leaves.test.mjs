import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {pathPattern, reaches} from './vault-policy-reaches.mjs';

// The credentials every release bump pushes the platform repositories with stand on a tier of
// their own, build-platform/, and never at build/<unit>/repo-pat: that leaf is a unit's own entry,
// written whole by the Manager, and a unit named hostyour-cloud or deploy would otherwise share it
// with the platform. The bootstrap seeds the hostyour-cloud leaf, which the bump of a platform
// repository on GitHub reads; the machine user hostyour-cloud-bump writes its own leaf beside it, so
// that a Forgejo token never stands where a bump still on GitHub reads. The deploy repository has the
// same pair: the Manager writes the deploy leaf from the App on its GitHub tick and never reads it, the
// machine user deploy-bump writes the Forgejo deploy leaf beside it, and the Manager reads that one where
// the forge holds the deploy repository. Every build namespace's secret reader reads the four by their
// literal paths, and nothing else on this host reaches the tier.
const CLOUD = 'build-platform/hostyour-cloud/repo-pat';
const FORGEJO_CLOUD = 'build-platform/hostyour-cloud/forgejo-repo-pat';
const DEPLOY = 'build-platform/deploy/repo-pat';
const FORGEJO_DEPLOY = 'build-platform/deploy/forgejo-repo-pat';
const READ = leaf => `path "secret/data/${leaf}" { capabilities = ["read"] }`;
const WRITE = leaf => `path "secret/data/${leaf}" { capabilities = ["create", "update"] }`;
const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-platform-services.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every way the program departs from the build-platform tier above. */
function findings(steps) {
  const found = [];
  const seeds = steps.filter(row => row.step === 'vault_kv_entry' && /^build(-platform)?\//.test(row.path));
  const cloudSeeds = seeds.filter(row => row.path === CLOUD);
  if (cloudSeeds.length !== 1 || JSON.stringify(cloudSeeds[0].fields) !== JSON.stringify(['pat=BUILD_HOSTYOUR_CLOUD_REPO_PAT'])) found.push(`${CLOUD} is not seeded once with pat=BUILD_HOSTYOUR_CLOUD_REPO_PAT`);
  for (const row of seeds.filter(row => row.path !== CLOUD)) found.push(`the bootstrap seeds ${row.path}, an entry it does not own`);

  const policies = steps.filter(row => row.step === 'vault_policy');
  const buildRead = policies.filter(row => row.name === '<cluster>-build-read');
  const managerHere = policies.filter(row => row.name === 'manager' && row.when.includes('build_plane_here_in_answers'));
  if (buildRead.length !== 1) found.push(`${buildRead.length} <cluster>-build-read policies, not 1`);
  if (managerHere.length !== 1) found.push(`${managerHere.length} manager policies where the build plane runs, not 1`);
  const allowed = new Set([
    ...buildRead.flatMap(row => [`${row.name} ${READ(CLOUD)}`, `${row.name} ${READ(FORGEJO_CLOUD)}`, `${row.name} ${READ(DEPLOY)}`, `${row.name} ${READ(FORGEJO_DEPLOY)}`]),
    ...managerHere.flatMap(row => [`${row.name} ${WRITE(DEPLOY)}`, `${row.name} ${READ(FORGEJO_DEPLOY)}`]),
  ]);
  for (const grant of allowed) if (!policies.some(row => row.rules.split('\n').some(line => `${row.name} ${line.trim()}` === grant))) found.push(`no grant ${grant}`);
  // The administrators' policy reaches every path by design and is handed to no workload.
  for (const row of policies.filter(row => row.name !== 'admin')) {
    for (const line of row.rules.split('\n').map(l => l.trim()).filter(Boolean)) {
      const pattern = pathPattern(line);
      const hits = [CLOUD, FORGEJO_CLOUD, DEPLOY, FORGEJO_DEPLOY].flatMap(leaf => [`secret/data/${leaf}`, `secret/metadata/${leaf}`]).filter(path => reaches(pattern, path));
      if (hits.length > 0 && !allowed.has(`${row.name} ${line}`)) found.push(`${row.name} reaches ${hits.join(', ')} with ${line}`);
    }
  }

  const text = JSON.stringify(steps);
  if (text.includes('deploy-pat-read')) found.push('a policy or a role names <cluster>-deploy-pat-read');
  for (const old of ['build/hostyour-cloud/repo-pat', 'build/deploy/repo-pat']) if (text.includes(old)) found.push(`a step names the old leaf ${old}`);
  return found;
}

test('the two platform bump credentials stand on build-platform/, seeded and granted literally, and nothing else reaches the tier', () => {
  assert.deepEqual(findings(program.steps), []);
});

test('PLANTED DEFECT: an old leaf, a missing seed or grant, a templated or extra grant, or the unread policy is found, and the program itself is not', () => {
  const policy = (rows, name, shape = 'build_plane_here_in_answers') => rows.find(row => row.step === 'vault_policy' && row.name === name && row.when.includes(shape));
  const seed = rows => rows.find(row => row.step === 'vault_kv_entry' && row.path === CLOUD);
  const planted = {
    'the bootstrap seeds the unit leaf build/hostyour-cloud/repo-pat': rows => { seed(rows).path = 'build/hostyour-cloud/repo-pat'; },
    'no seed of the hostyour-cloud leaf': rows => { rows.splice(rows.indexOf(seed(rows)), 1); },
    'the hostyour-cloud seed takes another answer': rows => { seed(rows).fields = ['pat=GITOPS_REPO_PAT']; },
    'a second bootstrap seed under build/': rows => { rows.push({...seed(rows), path: 'build/deploy/repo-pat'}); },
    'no read of the Forgejo hostyour-cloud leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(FORGEJO_CLOUD), ''); },
    'the manager reads the Forgejo hostyour-cloud leaf': rows => { const p = policy(rows, 'manager'); p.rules += `${READ(FORGEJO_CLOUD)}\n`; },
    'no read of the deploy leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(DEPLOY), ''); },
    'the build reader reads the old deploy leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(DEPLOY), READ('build/deploy/repo-pat')); },
    'a templated read of the tier': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules += 'path "secret/data/build-platform/{{identity.entity.aliases.<accessor>.metadata.unit}}/*" { capabilities = ["read"] }\n'; },
    'a wildcard read of the tier': rows => { const p = policy(rows, '<cluster>-bump-read'); p.rules += 'path "secret/data/build-platform/+/repo-pat" { capabilities = ["read"] }\n'; },
    'the manager writes no deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules = p.rules.replace(WRITE(DEPLOY), ''); },
    'no read of the Forgejo deploy leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(FORGEJO_DEPLOY), ''); },
    'the manager does not read the Forgejo deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules = p.rules.replace(READ(FORGEJO_DEPLOY), ''); },
    // PLANTED: the Manager able to read the entry its own GitHub tick rewrites with the App's token.
    'the manager reads the GitHub deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules += `${READ(DEPLOY)}\n`; },
    'the manager writes the Forgejo deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules += `${WRITE(FORGEJO_DEPLOY)}\n`; },
    'the manager reads the deploy leaf in one merged line': rows => { const p = policy(rows, 'manager'); p.rules = p.rules.replace(WRITE(DEPLOY), 'path "secret/data/build-platform/deploy/repo-pat" { capabilities = ["create", "read", "update"] }'); },
    'the manager reads the hostyour-cloud leaf': rows => { const p = policy(rows, 'manager'); p.rules += `${READ(CLOUD)}\n`; },
    'the manager writes the hostyour-cloud leaf': rows => { const p = policy(rows, 'manager'); p.rules += `${WRITE(CLOUD)}\n`; },
    'a role takes the deleted policy': rows => { const r = rows.find(row => row.step === 'vault_auth_role' && row.role === 'external-secrets'); r.body = r.body.replace('"<cluster>-eso"', '"<cluster>-eso","<cluster>-deploy-pat-read"'); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(findings(rows), [], name);
  }
  assert.deepEqual(findings(structuredClone(program.steps)), [], 'the planted innocent: the program as it is');
  assert.ok(!reaches('secret/data/build/{{identity.entity.aliases.<accessor>.metadata.unit}}/*', `secret/data/${DEPLOY}`), 'the planted innocent: the unit-templated build read reaches no build-platform leaf');
});

// The installation's one storage box login, <stage>/app/storage-box, opens every backup of the installation,
// and the units of external parties build in build namespaces too, so no role a build namespace logs in
// under reaches it, on any program of this repository.
const BOX = ['secret/data/<stage>/app/storage-box', 'secret/metadata/<stage>/app/storage-box'];
const BOX_READ = 'path "secret/data/<stage>/app/storage-box" { capabilities = ["read"] }';
const PROGRAMS = fileURLToPath(new URL('../ansiwise/programs/', import.meta.url));
const programs = readdirSync(PROGRAMS).filter(file => file.endsWith('.yaml'))
  .map(file => ({file, steps: JSON.parse(execFileSync('yq', ['-o=json', '.', `${PROGRAMS}${file}`], {encoding: 'utf8'})).steps ?? []}));

/** Whether a role's binding admits a build namespace: by the build label, by a name of one, by a glob or by an empty selector. */
function admitsBuildNamespace(body) {
  const role = JSON.parse(body);
  if ((role.bound_service_account_namespaces ?? []).some(name => name.includes('*') || name.endsWith('-build'))) return true;
  const selector = role.bound_service_account_namespace_selector;
  if (!selector) return false;
  const labels = JSON.parse(selector).matchLabels ?? {};
  return Object.keys(labels).length === 0 || labels['hostyour.cloud/build'] === 'true';
}

/** Every policy line, handed to a role a build namespace logs in under, that reaches the storage box login. */
function boxFindings(steps) {
  const found = [];
  for (const role of steps.filter(row => row.step === 'vault_auth_role' && admitsBuildNamespace(row.body))) {
    for (const name of JSON.parse(role.body).token_policies ?? []) {
      for (const policy of steps.filter(row => row.step === 'vault_policy' && row.name === name)) {
        for (const line of (policy.rules ?? '').split('\n').map(l => l.trim()).filter(Boolean)) {
          const hits = BOX.filter(path => reaches(pathPattern(line), path));
          if (hits.length > 0) found.push(`the role ${role.role} reaches ${hits.join(', ')} through ${name} with ${line}`);
        }
      }
    }
  }
  return found;
}

test('no role a build namespace logs in under reaches the storage box login', () => {
  assert.deepEqual(programs.flatMap(({file, steps}) => boxFindings(steps).map(finding => `${file}: ${finding}`)), []);
});

test('PLANTED DEFECT: a grant on the storage box login under a role of a build namespace is found, and the workload tier and the registry read are not', () => {
  const policy = (rows, name) => rows.find(row => row.step === 'vault_policy' && row.name === name);
  const planted = {
    'the login added to <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += `${BOX_READ}\n`; },
    'every stage\'s application tier in <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += 'path "secret/data/+/app/*" { capabilities = ["read"] }\n'; },
    'the bump reads the login': rows => { policy(rows, '<cluster>-bump-read').rules += `${BOX_READ}\n`; },
    'a delete of the login\'s metadata in <cluster>-build-read': rows => { policy(rows, '<cluster>-build-read').rules += 'path "secret/metadata/<stage>/app/storage-box" { capabilities = ["delete"] }\n'; },
    'the workload role admits a build namespace by name': rows => { for (const row of rows.filter(r => r.step === 'vault_auth_role' && r.role === 'external-secrets')) row.body = JSON.stringify({...JSON.parse(row.body), bound_service_account_namespaces: ['hostyour-cloud-build']}); },
    'the workload role admits every namespace': rows => { for (const row of rows.filter(r => r.step === 'vault_auth_role' && r.role === 'external-secrets')) row.body = JSON.stringify({...JSON.parse(row.body), bound_service_account_namespace_selector: '{}'}); },
  };
  for (const [name, plant] of Object.entries(planted)) {
    const rows = structuredClone(program.steps);
    plant(rows);
    assert.notDeepEqual(boxFindings(rows), [], name);
  }
  // The workload tier reaches the login by design, for the Manager's backups, and no build namespace logs in under it.
  const workload = policy(program.steps, '<cluster>-eso');
  assert.ok(workload.rules.split('\n').some(line => BOX.some(path => reaches(pathPattern(line), path))), 'the check sees a policy that reaches the login');
  assert.ok(policy(program.steps, '<cluster>-build-read').rules.includes('path "secret/data/<stage>/app/registry" { capabilities = ["read"] }'), 'the build reader keeps its registry read');
  for (const {file, steps} of programs) assert.deepEqual(boxFindings(structuredClone(steps)), [], `the planted innocent: ${file} as it is`);
});
