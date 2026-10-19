import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {forgejoCommand, installation, program, rendered, root, writeProducer} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/forgejo-machine-user.sh.tpl';
const BOOTSTRAP = 'forgejo-build-provisioner', PASSWORD = "fixture-bootstrap-password'$with-quotes";
// Placeholder organisations: no organisation name is fixed anywhere in the product.
const PLATFORM = 'orga/platform-repo', DEPLOY = 'orgb/deploy-repo', OTHER = 'orga/other-repo', ORGANISATIONS = 'orga,orgb';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const ANSWERS = {forgejo_platform_repository: PLATFORM, forgejo_deploy_repository: DEPLOY, forgejo_organisations: ORGANISATIONS};
// The Forgejo bump token of a repository stands beside the GitHub one and never on it: the bump of an
// installation still on GitHub reads GITHUB_LEAF until its platform URL switches, and the deploy
// repository's GitHub entry is rewritten by the Manager's tick with the App's token.
const GITHUB_LEAF = 'build-platform/hostyour-cloud/repo-pat';
const GITHUB_DEPLOY_LEAF = 'build-platform/deploy/repo-pat';
const USERS = {
  argocd: {entry: '<stage>/app/argocd-forge', fields: ['username', 'password']},
  'hostyour-cloud-bump': {entry: 'build-platform/hostyour-cloud/forgejo-repo-pat', fields: ['pat']},
  'deploy-bump': {entry: 'build-platform/deploy/forgejo-repo-pat', fields: ['pat']},
};
const rowsOf = (steps, user) => {
  const render = steps.find(s => s.path === `/run/forgejo-machine-user-${user}.sh`);
  return {render, writer: steps.find(s => s.producer === render?.path)};
};
const filled = values => Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v?.answer ? ANSWERS[v.answer] : v]));

function wiring(steps) {
  const problems = [], gate = ['secret_store_enabled', 'plane_runs_here', 'books_here_in_answers', 'build_plane_here_in_answers'];
  for (const [user, {entry, fields}] of Object.entries(USERS)) {
    const {render, writer} = rowsOf(steps, user);
    if (!render || !writer) { problems.push(user + ': no rows'); continue; }
    if (render.template !== TEMPLATE || writer.step !== 'vault_kv_entry_from_command') problems.push(user + ': not the producer pattern');
    if (writer.path !== entry || JSON.stringify(writer.fields) !== JSON.stringify(fields)) problems.push(user + ': wrong entry or fields');
    if (![render, writer].every(r => gate.every(c => r.when?.includes(c)))) problems.push(user + ': not guarded to a Forgejo installation');
    if (writer.on_failure !== 'exit') problems.push(user + ': failure continued');
    if (steps.filter(s => s.path === entry).length !== 1) problems.push(user + ': entry written twice');
    const reads = render.values['forgejo-permission'] === 'read';
    if (reads !== (user === 'argocd')) problems.push(user + ': wrong permission');
    if (user === 'argocd' ? render.values['forgejo-repository'] !== undefined : render.values['forgejo-organisations'] !== undefined) problems.push(user + ': reach of the wrong kind');
    // A read user proves its reading on the two repositories Argo CD syncs from, and a write user names neither.
    const proves = ['forgejo-platform-repository', 'forgejo-deploy-repository'].map(slot => render.values[slot]?.answer);
    if (JSON.stringify(proves) !== JSON.stringify(user === 'argocd' ? ['forgejo_platform_repository', 'forgejo_deploy_repository'] : [undefined, undefined])) problems.push(user + ': wrong repositories to prove');
  }
  if (steps.some(s => /forgejo-push|-push\.sh/.test(JSON.stringify(s)))) problems.push('a per-unit push user is minted');
  // GitHub credentials remain live until the clone URLs change.
  const seed = steps.find(s => s.path === GITHUB_LEAF && s.step === 'vault_kv_entry');
  if (JSON.stringify(seed?.when) !== JSON.stringify(['secret_store_enabled', 'build_plane_here_in_answers', 'books_here_in_answers'])) problems.push('the GitHub seed is not independent of Forgejo');
  if (JSON.stringify(seed?.fields) !== JSON.stringify(['pat=BUILD_HOSTYOUR_CLOUD_REPO_PAT'])) problems.push('the GitHub credential source changed');
  if (steps.some(s => [GITHUB_LEAF, GITHUB_DEPLOY_LEAF].includes(s.path) && s.step === 'vault_kv_entry_from_command')) problems.push('a Forgejo row writes the entry the GitHub bump reads');
  return problems;
}

test('three machine users follow the handoff, retain their guards and coexist with GitHub, and none per unit', () => {
  assert.deepEqual(wiring(program.steps), []);
  assert.equal(installation.conditions.forgejo_repositories_in_answers, undefined);
  assert.equal(installation.conditions.forgejo_repositories_absent_from_answers, undefined);
  const row = (steps, user) => rowsOf(steps, user);
  for (const defect of [
    // PLANTED: a row creating a per-unit push user and its entry.
    steps => steps.push({step: 'vault_kv_entry_from_command', path: '<stage>/app/forgejo-push', producer: '/run/forgejo-machine-user-unit-push.sh', fields: ['unit']}),
    steps => { row(steps, 'deploy-bump').writer.when = row(steps, 'deploy-bump').writer.when.filter(c => c !== 'plane_runs_here'); },
    steps => { row(steps, 'argocd').render.values['forgejo-permission'] = 'write'; },
    steps => { row(steps, 'hostyour-cloud-bump').render.values['forgejo-organisations'] = ORGANISATIONS; },
    steps => { steps.splice(steps.indexOf(row(steps, 'deploy-bump').writer), 1); },
    steps => { steps.find(s => s.path === GITHUB_LEAF && s.step === 'vault_kv_entry').when.pop(); },
    // PLANTED: the Forgejo bump token written over the live GitHub bump credential of an installation whose platform URL is still on GitHub.
    steps => { row(steps, 'hostyour-cloud-bump').writer.path = GITHUB_LEAF; },
    // PLANTED: the Forgejo deploy-bump token written over the entry the Manager's tick rewrites with the App's token.
    steps => { row(steps, 'deploy-bump').writer.path = GITHUB_DEPLOY_LEAF; },
    // PLANTED: Argo CD's user proves nothing it must read.
    steps => { delete row(steps, 'argocd').render.values['forgejo-deploy-repository']; },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
  assert.deepEqual(wiring([...program.steps]), []);
});

test('the producer renders under the engine\'s slot rule with exactly each row\'s values', () => {
  const template = readFileSync(new URL(TEMPLATE, root), 'utf8');
  for (const user of Object.keys(USERS)) {
    const {values} = rowsOf(program.steps, user).render;
    assert.ok(!rendered(template, filled(values)).match(/<[a-z][a-z0-9-]*\??>/));
    assert.throws(() => rendered(template, {...filled(values), 'forgejo-planted': 'x'}), /unplaced forgejo-planted/);
  }
});

// A stand-in for the pinned Forgejo 15.0.10 routes the producer calls: collaborators, teams, tokens and
// the user's own view. A user sees a repository by an explicit grant, by a team over all repositories
// of its organisation, or, unrestricted, as a public one. `restricted: false` makes the existing user
// unrestricted, and `ownerIsAdmin` makes the owners of the repositories administrators.
async function fixture(user, options = {}) {
  const {render, writer} = rowsOf(program.steps, user);
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-machine-user-'));
  const users = new Map([['akadmin', {email: 'akadmin@hostyour.invalid', admin: true, restricted: false, active: true}]]);
  if (options.exists) users.set(user, {email: user + '@hostyour.invalid', admin: options.admin ?? false, restricted: options.restricted ?? true, active: true});
  const repos = new Map([PLATFORM, DEPLOY, OTHER].map(n => [n, {private: true, grants: new Map(options.granted?.[n] ?? [])}]));
  const teams = new Map(), tokens = new Map(), requests = [];
  let generation = 0;
  const TOKEN = 'fixture-' + user + '-issued-secret';
  const right = (login, name) => {
    if (users.get(login)?.admin) return 'admin';
    const viaTeam = [...teams.values()].find(t => t.members.has(login) && t.org.toLowerCase() === name.split('/')[0].toLowerCase());
    return repos.get(name).grants.get(login) ?? (viaTeam ? viaTeam.permission : null);
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname;
    const send = (status, data = '') => { res.writeHead(status, {'content-type': 'application/json'}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (path === '/_command') {
      const {argv} = JSON.parse(text);
      const args = argv.slice(argv.indexOf('--') + 1);
      if (args.slice(0, 4).join(' ') === 'forgejo admin user generate-access-token') {
        generation++; tokens.set(TOKEN, {owner: args[args.indexOf('--username') + 1], name: args[args.indexOf('--token-name') + 1], scopes: args[args.indexOf('--scopes') + 1].split(','), repositories: null});
        return send(200, TOKEN + '\n');
      }
      const answered = forgejoCommand(argv, users, PASSWORD, {});
      return answered ? send(...answered) : send(500, 'unexpected command');
    }
    requests.push({method: req.method, path, body: text});
    const basic = req.headers.authorization === 'Basic ' + Buffer.from(BOOTSTRAP + ':' + PASSWORD).toString('base64') && users.has(BOOTSTRAP);
    const held = tokens.get(req.headers.authorization?.replace(/^token /, ''));
    const login = basic ? BOOTSTRAP : held?.owner;
    if (!login || !users.has(login)) return send(401);
    const scopes = basic ? null : held.scopes;
    const scoped = (...categories) => scopes === null || categories.every(c => scopes.includes('write:' + c) || (req.method === 'GET' && scopes.includes('read:' + c)));
    if (path === '/api/v1/user' && req.method === 'GET') {
      if (!scoped('user')) return send(403);
      const u = users.get(login); return send(200, {login, is_admin: u.admin, restricted: u.restricted, active: u.active});
    }
    if (path === '/api/v1/user/repos' && req.method === 'GET') {
      if (!scoped('user', 'repository')) return send(403);
      return send(200, [...repos.keys()].filter(n => right(login, n)).map(n => {
        const has = right(login, n); return {full_name: n, permissions: {admin: has === 'admin', push: has === 'admin' || has === 'write', pull: true}};
      }));
    }
    if (path === `/api/v1/users/${user}/tokens` && req.method === 'GET') {
      return send(200, [...tokens].filter(([, t]) => t.owner === user).map(([value, t], id) => ({id, name: t.name, token_last_eight: value.slice(-8), scopes: t.scopes, repositories: t.repositories})));
    }
    if (path.startsWith(`/api/v1/users/${user}/tokens/`) && req.method === 'DELETE') {
      for (const [value, t] of tokens) if (t.owner === user) tokens.delete(value);
      return send(204);
    }
    const collaborator = path.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)\/collaborators\/([^/]+)(\/permission)?$/);
    if (collaborator && basic) {
      const [, name, who, permission] = collaborator;
      if (!repos.has(name)) return send(404);
      if (req.method === 'PUT') { repos.get(name).grants.set(who, JSON.parse(text).permission); return send(204); }
      const has = right(who, name), u = users.get(who);
      // Forgejo 15.0.10 and 17.0.0 build the user block of this answer as the REPOSITORY OWNER sees it
      // (routers/api/v1/repo/collaborators.go passes ctx.User(), which on a /repos/{owner}/{repo} route
      // is the owner), not as the signed-in administrator does. An owner who is neither an administrator
      // nor the collaborator sees `is_admin` and `active` as false, whatever the account is.
      if (permission && req.method === 'GET') return send(200, {permission: has ?? 'none', user: {login: who, restricted: u.restricted, is_admin: options.ownerIsAdmin ? u.admin : false, active: options.ownerIsAdmin ? u.active : false}});
    }
    if (path === `/api/v1/users/${user}` && basic && req.method === 'GET') {
      const u = users.get(user);
      return u ? send(200, {login: user, is_admin: u.admin, restricted: u.restricted, active: u.active}) : send(404);
    }
    const org = path.match(/^\/api\/v1\/orgs\/([^/]+)\/teams$/)?.[1];
    if (org && basic) {
      if (req.method === 'POST') {
        const made = JSON.parse(text);
        assert.equal(made.permission, 'read'); assert.equal(made.includes_all_repositories, true);
        teams.set(teams.size + 1, {org, id: teams.size + 1, name: made.name, permission: 'read', includes_all_repositories: options.team?.includes_all_repositories ?? true, can_create_org_repo: false, members: new Set()});
        return send(201, '{}');
      }
      return send(200, [...teams.values()].filter(t => t.org === org).map(({members, ...team}) => team));
    }
    const member = path.match(/^\/api\/v1\/teams\/(\d+)\/members\/([^/]+)$/);
    if (member && basic && req.method === 'PUT') { teams.get(Number(member[1])).members.add(member[2]); return send(204); }
    const status = path.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)\/statuses\/[0-9a-f]+$/);
    if (status && req.method === 'POST') return send(scoped('repository') && ['admin', 'write'].includes(right(login, status[1])) ? 201 : 403);
    return send(500, 'unexpected path ' + path);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const clean = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true}); };
  let producer, kubectl;
  try { ({producer, kubectl} = await writeProducer(directory, TEMPLATE, {...filled(render.values), ...options.values}, {mutate: options.mutate, mutateModule: options.mutateModule, port})); } catch (error) { await clean(); throw error; }
  const run = (entry, mode = '--apply') => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, mode, '--', kubectl], {cwd: directory});
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject); child.on('close', (code) => resolve({code, stdout, stderr}));
    child.stdin.end(JSON.stringify({entry, inputs: {}}));
  });
  const write = (repo, token) => fetch(`http://127.0.0.1:${port}/api/v1/repos/${repo}/statuses/${SHA}`, {method: 'POST', headers: {authorization: 'token ' + token}, body: '{}'}).then(r => r.status);
  return {run, clean, users, tokens, teams, repos, requests, TOKEN, writer, get generation() { return generation; }, right, write};
}

const expected = (user, token) => user === 'argocd' ? {username: 'argocd', password: token} : {pat: token};
const REACH = {'hostyour-cloud-bump': PLATFORM, 'deploy-bump': DEPLOY};

test('a bump user is created restricted, granted write on its one repository, and returns exactly its fields', async () => {
  for (const user of ['hostyour-cloud-bump', 'deploy-bump']) {
    const f = await fixture(user);
    try {
      const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected(user, f.TOKEN));
      assert.deepEqual(Object.keys(JSON.parse(r.stdout)), USERS[user].fields);
      assert.equal(f.generation, 1); assert.ok(!f.users.has(BOOTSTRAP)); assert.equal(f.users.get(user).restricted, true);
      assert.deepEqual([...f.tokens.get(f.TOKEN).scopes].sort(), ['read:user', 'write:repository']);
      for (const name of [PLATFORM, DEPLOY, OTHER]) assert.equal(f.right(user, name), name === REACH[user] ? 'write' : null, user + ' on ' + name);
      // A held valid token is kept: a rerun mints nothing and a check is satisfied.
      const again = await f.run(expected(user, f.TOKEN)); assert.equal(again.code, 0, again.stderr);
      assert.equal(f.generation, 1);
      const check = await f.run(expected(user, f.TOKEN), '--check'); assert.deepEqual(JSON.parse(check.stdout), {satisfied: true});
    } finally { await f.clean(); }
  }
});

// The account as the repository owner sees it: the read the producer used to make of a grant.
const READS_THE_OWNERS_VIEW = module => [
  ["api('GET', '/users/' + user, auth, (200,))", "api('GET', '/repos/' + repo + '/collaborators/' + user + '/permission', auth, (200,))"],
  ["person = object_json(raw, 'Forgejo user')", "person = object_json(raw, 'Forgejo user').get('user', {})"],
].reduce((text, [from, to]) => { assert.ok(text.includes(from), 'the planted read replaces ' + from); return text.replace(from, to); }, module);

test('a bump user is granted on a repository an organisation owns, where Forgejo shows the collaborator as its owner sees it', async () => {
  for (const user of ['hostyour-cloud-bump', 'deploy-bump']) {
    // The failing state of the master redeploy of 2026-10-19: the owner is not an administrator.
    const f = await fixture(user);
    try {
      const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected(user, f.TOKEN));
      assert.equal(f.right(user, REACH[user]), 'write');
    } finally { await f.clean(); }
    // PLANTED: the account read from the owner's view of the grant (red).
    const owners = await fixture(user, {mutateModule: READS_THE_OWNERS_VIEW});
    try {
      const r = await owners.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, new RegExp(user + ' is not an active restricted non-admin user'));
    } finally { await owners.clean(); }
    // INNOCENT: an administrator owns the repository, so the owner's view is the full account.
    const administered = await fixture(user, {ownerIsAdmin: true, mutateModule: READS_THE_OWNERS_VIEW});
    try {
      const r = await administered.run(null); assert.equal(r.code, 0, r.stderr);
      assert.equal(administered.right(user, REACH[user]), 'write');
    } finally { await administered.clean(); }
  }
});

test('an existing bump user that is not restricted is refused before any grant', async () => {
  for (const user of ['hostyour-cloud-bump', 'deploy-bump']) {
    // PLANTED: an unrestricted account of the user's name (red).
    const f = await fixture(user, {exists: true, restricted: false});
    try {
      const r = await f.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, new RegExp(user + ' is not an active restricted non-admin user'));
      assert.deepEqual(f.requests.filter(q => q.method !== 'GET'), [], 'nothing was granted');
      assert.equal(f.generation, 0);
    } finally { await f.clean(); }
  }
});

test('a bump user with write on a second repository, or with administration rights, is refused', async () => {
  for (const user of ['hostyour-cloud-bump', 'deploy-bump']) {
    // PLANTED: write on a second repository (red).
    const wide = await fixture(user, {exists: true, granted: {[OTHER]: [[user, 'write']]}});
    try {
      const r = await wide.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, /unrelated repository/);
      assert.equal(r.stdout, '');
    } finally { await wide.clean(); }
    // PLANTED: a user with administration rights (red, refused by name).
    const admin = await fixture(user, {exists: true, admin: true});
    try {
      const r = await admin.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, new RegExp(user + ' must be an active non-admin user'));
      assert.equal(admin.generation, 0);
    } finally { await admin.clean(); }
  }
});

test('argocd joins a read-only team of every organisation and reads, and a user that writes is refused', async () => {
  const f = await fixture('argocd');
  try {
    const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), expected('argocd', f.TOKEN));
    assert.deepEqual([...f.tokens.get(f.TOKEN).scopes].sort(), ['read:repository', 'read:user']);
    assert.deepEqual([...f.teams.values()].map(t => t.org).sort(), ['orga', 'orgb']);
    for (const name of [PLATFORM, DEPLOY, OTHER]) assert.equal(f.right('argocd', name), 'read', 'argocd on ' + name);
    assert.equal(await f.write(PLATFORM, f.TOKEN), 403, 'the read token sets no status');
    const again = await f.run(expected('argocd', f.TOKEN)); assert.equal(again.code, 0, again.stderr);
    assert.equal(f.generation, 1); assert.equal(f.teams.size, 2);
  } finally { await f.clean(); }
  // PLANTED: argocd with write on a repository (red).
  const writer = await fixture('argocd', {exists: true, granted: {[PLATFORM]: [['argocd', 'write']]}});
  try {
    const r = await writer.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, /unrelated repository/);
  } finally { await writer.clean(); }
  // PLANTED: a team that is not over all repositories is refused rather than trusted.
  const narrow = await fixture('argocd', {team: {includes_all_repositories: false}});
  try {
    const r = await narrow.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, /not a read-only team over all repositories/);
  } finally { await narrow.clean(); }
});

test('a check of argocd is not satisfied while its token misses a repository it must read, and an apply restores the reading with the token it holds', async () => {
  for (const lost of [['orga', 'orgb'], ['orgb']]) {
    const f = await fixture('argocd');
    try {
      const first = await f.run(null); assert.equal(first.code, 0, first.stderr);
      const held = expected('argocd', f.TOKEN);
      // PLANTED: the team membership is gone and the token stays valid, so /user/repos lists none of the repositories (or not the deploy repository).
      for (const team of f.teams.values()) if (lost.includes(team.org)) team.members.delete('argocd');
      assert.equal([...f.repos.keys()].filter(n => f.right('argocd', n)).length, lost.length === 2 ? 0 : 2);
      const check = await f.run(held, '--check'); assert.equal(check.code, 0, check.stderr);
      assert.deepEqual(JSON.parse(check.stdout), {satisfied: false}, 'lost reading of ' + lost);
      const apply = await f.run(held); assert.equal(apply.code, 0, apply.stderr);
      assert.deepEqual(JSON.parse(apply.stdout), held); assert.equal(f.generation, 1, 'no new token');
      // The innocent case: both repositories are listed again.
      const again = await f.run(held, '--check'); assert.deepEqual(JSON.parse(again.stdout), {satisfied: true});
    } finally { await f.clean(); }
  }
});

test('argocd refuses organisations that omit a repository owner before it changes anything, and accepts every owner listed', async () => {
  // PLANTED: the finding's case, organisations that name neither owner, and each owner left out alone.
  for (const organisations of ['foreign-team', 'orga', 'orgb', 'orga,foreign-team']) {
    for (const mode of ['--apply', '--check']) {
      const f = await fixture('argocd', {values: {'forgejo-organisations': organisations}});
      try {
        const r = await f.run(null, mode); assert.notEqual(r.code, 0, organisations + ' ' + mode);
        assert.match(r.stderr, /organisations of argocd must include the owner of every repository it reads/);
        assert.equal(r.stdout, '');
        assert.deepEqual(f.requests.filter(q => q.method !== 'GET'), [], 'nothing was changed in Forgejo');
        assert.equal(f.teams.size, 0); assert.equal(f.users.has('argocd'), false); assert.equal(f.generation, 0);
      } finally { await f.clean(); }
    }
  }
  // INNOCENT: more organisations than the owners, and the owners in another letter case.
  for (const organisations of ['orga,orgb,extra', 'ORGA,Orgb']) {
    const f = await fixture('argocd', {values: {'forgejo-organisations': organisations}});
    try {
      const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), expected('argocd', f.TOKEN));
    } finally { await f.clean(); }
  }
});

test('a row with an empty answer, or the wrong kind of reach, refuses by what it needs', async () => {
  const unproven = await fixture('argocd', {values: {'forgejo-deploy-repository': ''}});
  try {
    const r = await unproven.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, /argocd needs .*to read/);
    assert.equal(unproven.users.has('argocd'), false);
  } finally { await unproven.clean(); }
  const empty = await fixture('deploy-bump', {values: {'forgejo-repository': ''}});
  try {
    const r = await empty.run(null); assert.notEqual(r.code, 0); assert.match(r.stderr, /deploy-bump needs one owner\/repository to write/);
    assert.equal(empty.users.has('deploy-bump'), false);
  } finally { await empty.clean(); }
});
