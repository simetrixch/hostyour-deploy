import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {reaches} from './vault-policy-reaches.mjs';

// The two credentials every release bump pushes the platform repositories with stand on a tier of
// their own, build-platform/, and never at build/<unit>/repo-pat: that leaf is a unit's own entry,
// written whole by the Manager, and a unit named hostyour-cloud or deploy would otherwise share it
// with the platform. The bootstrap seeds the hostyour-cloud leaf,
// the Manager writes the deploy leaf from the App, every build namespace's secret reader reads both
// by their literal paths, and nothing else on this host reaches the tier.
const CLOUD = 'build-platform/hostyour-cloud/repo-pat';
const DEPLOY = 'build-platform/deploy/repo-pat';
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
    ...buildRead.flatMap(row => [`${row.name} ${READ(CLOUD)}`, `${row.name} ${READ(DEPLOY)}`]),
    ...managerHere.map(row => `${row.name} ${WRITE(DEPLOY)}`),
  ]);
  for (const grant of allowed) if (!policies.some(row => row.rules.split('\n').some(line => `${row.name} ${line.trim()}` === grant))) found.push(`no grant ${grant}`);
  // The administrators' policy reaches every path by design and is handed to no workload.
  for (const row of policies.filter(row => row.name !== 'admin')) {
    for (const line of row.rules.split('\n').map(l => l.trim()).filter(Boolean)) {
      const pattern = /^path "([^"]+)"/.exec(line)?.[1] ?? '';
      const hits = [CLOUD, DEPLOY].flatMap(leaf => [`secret/data/${leaf}`, `secret/metadata/${leaf}`]).filter(path => reaches(pattern, path));
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
    'no read of the deploy leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(DEPLOY), ''); },
    'the build reader reads the old deploy leaf': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules = p.rules.replace(READ(DEPLOY), READ('build/deploy/repo-pat')); },
    'a templated read of the tier': rows => { const p = policy(rows, '<cluster>-build-read'); p.rules += 'path "secret/data/build-platform/{{identity.entity.aliases.<accessor>.metadata.unit}}/*" { capabilities = ["read"] }\n'; },
    'a wildcard read of the tier': rows => { const p = policy(rows, '<cluster>-bump-read'); p.rules += 'path "secret/data/build-platform/+/repo-pat" { capabilities = ["read"] }\n'; },
    'the manager writes no deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules = p.rules.replace(WRITE(DEPLOY), ''); },
    'the manager reads the deploy leaf': rows => { const p = policy(rows, 'manager'); p.rules = p.rules.replace(WRITE(DEPLOY), 'path "secret/data/build-platform/deploy/repo-pat" { capabilities = ["create", "read", "update"] }'); },
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
