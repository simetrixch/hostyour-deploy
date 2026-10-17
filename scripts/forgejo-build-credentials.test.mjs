import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, writeFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';

const root = new URL('../', import.meta.url);
const USER = 'forgejo-build', BOOTSTRAP = 'forgejo-build-provisioner';
const REPO = 'akadmin/hostyour-release-test';
const PLANE = 'fixture-plane-update-status-secret';
const TOKEN = 'fixture-forgejo-build-issued-secret';
const PASSWORD = "fixture-bootstrap-password'$with-quotes";
const entry = {'forgejo-user': USER, 'forgejo-api-token': TOKEN, 'plane-api-token': PLANE};
// The engine's template rule (ansiwise-core lib/src/steps/slots.dart slotPattern, template.dart
// filledWith): every required slot names a value of the row, every value has a slot, and a line
// whose optional slot the row leaves out is dropped whole.
function rendered(text, values) {
  const slots = [...text.matchAll(/<([a-z][a-z0-9-]*)(!\?|\??)>/g)];
  const unfilled = slots.filter(([, name, suffix]) => suffix === '' && !(name in values)).map(([slot]) => slot);
  const unplaced = Object.keys(values).filter(name => !slots.some(([, slot]) => slot === name));
  if (slots.some(([, , suffix]) => suffix === '!?')) throw new Error('this fixture renders no carried slot');
  if (unfilled.length || unplaced.length) throw new Error(`template and values do not fit: unfilled ${unfilled}, unplaced ${unplaced}`);
  return text.split('\n').filter(line => [...line.matchAll(/<([a-z][a-z0-9-]*)\?>/g)].every(([, name]) => name in values))
    .join('\n').replace(/<([a-z][a-z0-9-]*)\??>/g, (_, name) => values[name]);
}

const yaml = file => JSON.parse(execFileSync('yq', ['-o=json', '.', new URL(file, root).pathname], {encoding: 'utf8'}));
const program = yaml('ansiwise/programs/deploy-platform-services.yaml');
const installation = yaml('ansiwise.yaml');

function wiring(steps) {
  const writers = steps.filter(s => s.path === '<stage>/app/forgejo-build');
  if (writers.length !== 1 || writers[0].step !== 'vault_kv_entry_from_command') return ['not one complete-entry writer'];
  const row = writers[0], problems = [];
  if (JSON.stringify(row.fields) !== JSON.stringify(Object.keys(entry))) problems.push('not the three credential fields');
  if (JSON.stringify(row.fields_from_answers) !== JSON.stringify(['plane-api-token=plane_api_token'])) problems.push('missing secret input');
  const render = steps.find(s => s.path === row.producer);
  const machine = ['books_here_in_answers', 'build_plane_here_in_answers', 'plane_runs_here'];
  if (![row, render].every(r => machine.every(c => r?.when?.includes(c)))) problems.push('wrong machine');
  if (row.on_failure !== 'exit') problems.push('failure continued');
  if (render?.step !== 'write_file_from_template' || render.template !== 'ansiwise/templates/forgejo-build-credentials.sh.tpl') problems.push('no application producer');
  if (steps.indexOf(row) <= steps.findIndex(s => s.manifest === 'clusters/argocd/root-app.yaml')) problems.push('before Forgejo can start');
  return problems;
}

test('one installer writer follows the handoff and reads the optional secret answer', () => {
  assert.deepEqual(wiring(program.steps), []);
  // Conditions are measured before the first row, so a first installation finds no Plane yet.
  assert.deepEqual(installation.conditions.plane_runs_here, {predicate: 'kubernetes_object_present', kind: 'deployments.apps',
    name: 'plane-api-wl', namespace: 'plane', kubectl: ['microk8s', 'kubectl'], kubectl_needs_root: true});
  const answer = program.answers.find(a => a.name === 'plane_api_token');
  assert.equal(answer?.secret, true);
  assert.equal(answer?.required, false);
  assert.equal(answer?.default, undefined);
  for (const defect of [
    steps => steps.push(structuredClone(steps.find(s => s.path === '<stage>/app/forgejo-build'))),
    steps => { steps.find(s => s.path === '<stage>/app/forgejo-build').fields.push('plane-project'); },
    steps => { steps.find(s => s.path === '<stage>/app/forgejo-build').on_failure = 'continue'; },
    steps => { const row = steps.find(s => s.path === '<stage>/app/forgejo-build'); row.when = row.when.filter(c => c !== 'plane_runs_here'); },
    steps => { const row = steps.find(s => s.template === 'ansiwise/templates/forgejo-build-credentials.sh.tpl'); row.when = row.when.filter(c => c !== 'plane_runs_here'); },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
  assert.deepEqual(wiring([...program.steps]), []);
});

test('the producer template renders under the engine\'s slot rule with exactly the row\'s values', () => {
  const template = readFileSync(new URL('ansiwise/templates/forgejo-build-credentials.sh.tpl', root), 'utf8');
  const {values} = program.steps.find(s => s.template === 'ansiwise/templates/forgejo-build-credentials.sh.tpl');
  assert.ok(!rendered(template, values).match(/<[a-z][a-z0-9-]*\??>/));
  // PLANTED: an angle-bracketed word in a comment is a slot no row fills, and the engine refuses it.
  assert.throws(() => rendered(template.replace('# The installer', '# GET /users/<user>/tokens\n# The installer'), values), /unfilled <user>/);
  assert.throws(() => rendered(template, {...values, 'forgejo-planted': 'x'}), /unplaced forgejo-planted/);
});

const SCOPES = ['read:user', 'write:repository'];
const UNRELATED = 'akadmin/unrelated';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// A stand-in for the pinned Forgejo 15.0.10 routes the producer and a build call. It answers by the
// token's scopes, then the repository, then the user's right, in the order routers/api/v1/api.go
// checks them: a token needs write:<category> for POST, PUT and DELETE and read or write otherwise
// (api.go:252-260, permissions/token_requires_scopes.go:13-39); /user and /users/<name> need the user
// category (api.go:611, :760), /user/repos the repository category as well (api.go:722); public-only
// hides private repositories (services/authz/public_repos_reducer.go); basic auth carries no scope.
async function fixture(options = {}) {
  // Rendered first: a template the engine would refuse starts no server.
  const source = await readFile(new URL('ansiwise/templates/forgejo-build-credentials.sh.tpl', root), 'utf8');
  const render = program.steps.find(s => s.template === 'ansiwise/templates/forgejo-build-credentials.sh.tpl');
  // The grant cases name the proof repository; `shipped` renders with the row's values as they are.
  let script = rendered(options.mutate ? options.mutate(source) : source,
    options.shipped ? render.values : {...render.values, 'forgejo-repositories': REPO});
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-credentials-'));
  const commands = [], requests = [];
  const users = new Map([['akadmin', {email: 'akadmin@hostyour.invalid', admin: true, restricted: false, active: true}]]);
  if (options.exists !== false) users.set(USER, {email: USER + '@hostyour.invalid', admin: false, restricted: true, active: true, ...options.badUser});
  if (options.staleBootstrap) users.set(BOOTSTRAP, {email: BOOTSTRAP + '@hostyour.invalid', admin: true, restricted: false, active: true});
  const repos = new Map(options.repositories === false ? [] : [
    [REPO, {private: false, grants: new Map(options.granted === false ? [] : [[USER, options.repoAdmin ? 'admin' : 'write']])}],
    [UNRELATED, {private: options.privateUnrelated ?? false, grants: new Map(options.unrelated ? [[USER, 'write']] : [])}],
  ]);
  const tokens = new Map();
  if (options.valid !== false) tokens.set(TOKEN, options.ownerToken ? {owner: 'akadmin', name: 'admin', scopes: ['all'], repositories: null} : {owner: USER, name: USER, scopes: SCOPES, repositories: null});
  if (options.staleToken) tokens.set('lost-fixture-secret', {owner: USER, name: USER, scopes: SCOPES, repositories: null});
  if (options.held) tokens.set(options.held.value, {owner: USER, name: USER, repositories: null, ...options.held});
  let generation = 0;
  const right = (login, repo) => users.get(login)?.admin ? 'admin' : repo.grants.get(login) ?? (repo.private || users.get(login)?.restricted ? null : 'read');
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname;
    const send = (status, data = '') => { res.writeHead(status, {'content-type': 'application/json'}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (path === '/_command') {
      const argv = JSON.parse(text); commands.push(argv);
      if (argv.includes('get') && argv.includes('pods')) {
        if (options.unreadable) return send(500, TOKEN);
        return send(200, {items: options.absentPod ? [] : [{metadata: {name: 'fixture-pod'}, status: {podIP: '127.0.0.1', conditions: [{type: 'Ready', status: 'True'}]}}]});
      }
      const args = argv.slice(argv.indexOf('--') + 1);
      if (args.slice(0, 3).join(' ') !== 'forgejo admin user') return send(500, TOKEN);
      const name = args[args.indexOf('--username') + 1];
      switch (args[3]) {
        case 'list': return send(200, 'ID Username Email IsActive IsAdmin 2FA\n' + [...users].map(([n, v], i) => `${i + 1} ${n} ${v.email} ${v.active} ${v.admin} false`).join('\n') + '\n');
        case 'create':
          assert.ok(!args.includes('--password'), 'no password in arguments');
          assert.ok(args.includes('--random-password'));
          if (users.has(name)) return send(500, 'already exists');
          users.set(name, {email: args[args.indexOf('--email') + 1], admin: args.includes('--admin'), restricted: args.includes('--restricted'), active: true});
          return send(200, `generated random password is '${PASSWORD}'\nNew user created\n`);
        case 'delete': users.delete(name); return send(200);
        case 'generate-access-token':
          assert.equal(args[args.indexOf('--token-name') + 1], USER);
          assert.ok(args.includes('--raw'));
          if ([...tokens.values()].some(t => t.owner === name && t.name === USER)) return send(500, 'same name exists');
          generation++; tokens.set(TOKEN, {owner: name, name: USER, scopes: args[args.indexOf('--scopes') + 1].split(','), repositories: null});
          return send(200, TOKEN + '\n');
        default: return send(500, 'unexpected command');
      }
    }
    requests.push({method: req.method, path, body: text});
    if (options.apiFailure) return send(503, TOKEN);
    const basic = req.headers.authorization === 'Basic ' + Buffer.from(BOOTSTRAP + ':' + PASSWORD).toString('base64') && users.has(BOOTSTRAP);
    const held = tokens.get(req.headers.authorization?.replace(/^token /, ''));
    const actor = basic ? {login: BOOTSTRAP, scopes: null} : held && users.has(held.owner) ? {login: held.owner, ...held} : null;
    if (!actor) return send(401, TOKEN);
    const scoped = (...categories) => actor.scopes === null || categories.every(c => actor.scopes.includes('all') ||
      actor.scopes.includes('write:' + c) || (req.method === 'GET' && actor.scopes.includes('read:' + c)));
    const visible = (name, repo) => actor.scopes === null || ((!actor.scopes.includes('public-only') || !repo.private) &&
      (actor.repositories === null || actor.repositories.includes(name)));
    const page = list => list.slice((Number(url.searchParams.get('page')) - 1) * 50, Number(url.searchParams.get('page')) * 50);
    if (options.pause && basic) await new Promise(resolve => setTimeout(resolve, 200));
    if (path === '/api/v1/user' && req.method === 'GET') {
      if (!scoped('user')) return send(403, TOKEN);
      const u = users.get(actor.login);
      return send(200, {login: actor.login, is_admin: u.admin, restricted: u.restricted, active: u.active});
    }
    if (path === '/api/v1/user/repos' && req.method === 'GET') {
      if (!scoped('user', 'repository')) return send(403, TOKEN);
      return send(200, page([...repos].filter(([n, r]) => right(actor.login, r) && visible(n, r)).map(([n, r]) => {
        const has = right(actor.login, r);
        return {full_name: n, private: r.private, permissions: {admin: has === 'admin', push: has === 'admin' || has === 'write', pull: true}};
      })));
    }
    if (path === '/api/v1/users/' + USER + '/tokens' && req.method === 'GET') {
      if (!scoped('user')) return send(403, TOKEN);
      if (actor.login !== USER && !users.get(actor.login)?.admin) return send(403);
      return send(200, page([...tokens].filter(([, t]) => t.owner === USER).map(([value, t], id) =>
        ({id, name: t.name, token_last_eight: value.slice(-8), scopes: t.scopes, repositories: t.repositories}))));
    }
    if (path === '/api/v1/users/' + USER + '/tokens/' + USER && req.method === 'DELETE') {
      if (!basic) return send(401);
      for (const [value, t] of tokens) if (t.owner === USER && t.name === USER) tokens.delete(value);
      return send(204);
    }
    const repoPath = path.match(/^\/api\/v1\/repos\/([^/]+\/[^/]+)(\/.*)$/);
    if (repoPath) {
      if (!scoped('repository')) return send(403, TOKEN);
      const [, name, rest] = repoPath, repo = repos.get(name);
      if (!repo || !visible(name, repo) || !right(actor.login, repo)) return send(404);
      const has = right(actor.login, repo);
      if (rest === '/collaborators/' + USER && req.method === 'PUT') {
        if (has !== 'admin') return send(403);
        assert.deepEqual(JSON.parse(text), {permission: 'write'});
        repo.grants.set(USER, 'write'); return send(204);
      }
      const asked = rest.match(/^\/collaborators\/([^/]+)\/permission$/)?.[1];
      if (asked && req.method === 'GET') {
        if (asked !== actor.login && has !== 'admin') return send(403);
        const u = users.get(asked);
        return send(200, {permission: right(asked, repo) ?? 'none', user: {login: asked, is_admin: u.admin, restricted: u.restricted, active: u.active}});
      }
      if (rest === '/statuses/' + SHA && req.method === 'POST') return send(has === 'admin' || has === 'write' ? 201 : 403);
    }
    return send(500, 'unexpected path');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  script = script.replace("/run/forgejo-build-credentials.lock", join(directory, "credentials.lock")).replace("PORT = 3000", 'PORT = ' + port).replace("POD_WAIT_SECONDS = 30", 'POD_WAIT_SECONDS = 0.1');
  const producer = join(directory, 'forgejo-build-credentials.sh'), kubectl = join(directory, 'kubectl');
  await writeFile(producer, script);
  await writeFile(kubectl, `#!/usr/bin/env node
const r = await fetch('http://127.0.0.1:${port}/_command', {method:'POST',body:JSON.stringify(process.argv.slice(2))});
process.stdout.write(await r.text());process.exit(r.status===200?0:1);
`, {mode: 0o700});
  const run = (held, supplied = PLANE, mode = '--apply', cancel = false) => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, mode, '--', kubectl], {cwd: directory});
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', (code, signal) => resolve({code, signal, stdout, stderr}));
    child.stdin.end(JSON.stringify({entry: held, inputs: supplied === null ? {} : {'plane-api-token': supplied}}));
    if (cancel) {
      const timer = setInterval(() => {
        if (users.has(BOOTSTRAP)) {clearInterval(timer); child.kill('SIGTERM');}
      }, 5);
      child.on('close', () => clearInterval(timer));
    }
  });
  const clean = async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true});};
  const privateFiles = async () => {
    for (const file of await readdir(directory)) {
      const text = await readFile(join(directory, file), 'utf8');
      for (const secret of [PLANE, TOKEN, PASSWORD]) assert.ok(!text.includes(secret), file + ' holds a credential');
    }
    for (const args of commands) for (const secret of [PLANE, TOKEN, PASSWORD]) assert.ok(!args.join(' ').includes(secret));
  };
  const write = (repo, token) => fetch(`http://127.0.0.1:${port}/api/v1/repos/${repo}/statuses/${SHA}`,
    {method: 'POST', headers: {authorization: 'token ' + token}, body: '{}'}).then(r => r.status);
  return {run, clean, privateFiles, write, users, tokens, commands, requests, get generation() {return generation;}};
}

test('first creation grants only the proof repository and returns exactly three fields', async () => {
  const f = await fixture({exists: false, granted: false});
  try {
    const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), entry);
    assert.equal(f.generation, 1); assert.ok(!f.users.has(BOOTSTRAP));
    assert.deepEqual(f.tokens.get(TOKEN).scopes, ['write:repository', 'read:user']);
    assert.ok(f.requests.some(r => r.method === 'PUT' && r.path.includes(REPO)));
    // The token the user may write with reaches the proof repository and is refused elsewhere.
    assert.equal(await f.write(REPO, TOKEN), 201);
    assert.equal(await f.write(UNRELATED, TOKEN), 404);
    await f.privateFiles();
  } finally {await f.clean();}
  // PLANTED DEFECT: the owner's write:repository alone cannot read GET /user, so nothing validates.
  const narrow = await fixture({exists: false, granted: false, mutate: text => text.replace("SCOPES = 'write:repository,read:user'", "SCOPES = 'write:repository'")});
  try {
    const r = await narrow.run(null);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /did not validate/);
    assert.equal(r.stdout, '');
  } finally {await narrow.clean();}
});

test('the stand-in refuses an unrelated write by the user\'s rights, and the producer refuses those rights', async () => {
  for (const privateUnrelated of [false, true]) {
    const f = await fixture({unrelated: true, privateUnrelated});
    try {
      // PLANTED DEFECT: broader rights make the same write succeed, so the 404 above is the rights' answer.
      assert.equal(await f.write(UNRELATED, TOKEN), 201);
      const r = await f.run(entry);
      assert.notEqual(r.code, 0); assert.match(r.stderr, /unrelated repository/);
      assert.equal(f.generation, 0);
    } finally {await f.clean();}
  }
});

test('a standing token without write scope is replaced, never returned', async () => {
  const held = {value: 'fixture-forgejo-build-read-only-secret', scopes: ['read:repository', 'read:user']};
  const f = await fixture({valid: false, held});
  try {
    assert.equal(await f.write(REPO, held.value), 403, 'the read-only token cannot set a status');
    const standing = {...entry, 'forgejo-api-token': held.value};
    const check = await f.run(standing, PLANE, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    const r = await f.run(standing); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), entry);
    assert.equal(f.generation, 1);
    assert.equal(await f.write(REPO, TOKEN), 201);
    assert.ok(!f.tokens.has(held.value), 'the read-only same-name token was removed');
    await f.privateFiles();
  } finally {await f.clean();}
});

test('a public-only standing token cannot hide a private unrelated grant', async () => {
  const held = {value: 'fixture-forgejo-build-public-only-secret', scopes: ['public-only', 'write:repository', 'read:user']};
  const f = await fixture({valid: false, held, unrelated: true, privateUnrelated: true});
  try {
    const standing = {...entry, 'forgejo-api-token': held.value};
    const check = await f.run(standing, PLANE, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    const r = await f.run(standing);
    assert.notEqual(r.code, 0); assert.match(r.stderr, /unrelated repository/);
    assert.equal(r.stdout, '');
    assert.ok(!f.users.has(BOOTSTRAP));
    await f.privateFiles();
  } finally {await f.clean();}
});

test('valid credentials survive retries, later callers and Plane-only rotation without minting', async () => {
  const f = await fixture();
  try {
    for (const supplied of [PLANE, null, 'fixture-plane-replacement']) {
      const r = await f.run(entry, supplied);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {...entry, 'plane-api-token': supplied ?? PLANE});
    }
    assert.equal(f.generation, 0);
    assert.equal(f.commands.filter(c => c.includes('create') || c.includes('delete')).length, 0);
    const before = f.requests.length;
    const check = await f.run(entry, PLANE, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: true});
    assert.ok(f.requests.slice(before).every(r => r.method === 'GET'), 'a check only reads');
    await f.privateFiles();
  } finally {await f.clean();}
});

// Forgejo on the master holds no repository since 2026-10-17 01:39 UTC, when the proof repository
// was deleted; the row names none, so a valid held token with no write right anywhere is kept.
test('with Forgejo holding no repository, the row\'s values keep a valid held token without a write', async () => {
  // PLANTED DEFECT: a row that names a repository Forgejo does not hold fails as run 20261017T090957Z did.
  const named = await fixture({repositories: false});
  try {
    const check = await named.run(entry, PLANE, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    const r = await named.run(entry);
    assert.equal(r.code, 1); assert.equal(r.stdout, '');
    assert.match(r.stderr, /refused PUT \/repos\/akadmin\/hostyour-release-test\/collaborators\/forgejo-build with HTTP 404/);
    assert.ok(!named.users.has(BOOTSTRAP));
  } finally {await named.clean();}
  const f = await fixture({shipped: true, repositories: false});
  try {
    const check = await f.run(entry, PLANE, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: true});
    const r = await f.run(entry); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), entry);
    assert.ok(f.requests.every(r => r.method === 'GET'), 'no PUT and no DELETE');
    assert.ok(f.commands.every(c => c.includes('get') || c.includes('list')), 'no user created and no token generated');
    assert.equal(f.generation, 0); assert.ok(!f.users.has(BOOTSTRAP));
    await f.privateFiles();
  } finally {await f.clean();}
});

test('with no repository named, every write right is refused and a token not issued here is minted again', async () => {
  for (const [options, refusal] of [[{}, /unrelated repository/], [{repoAdmin: true}, /administration rights/]]) {
    const f = await fixture({shipped: true, ...options});
    try {
      const r = await f.run(entry);
      assert.notEqual(r.code, 0); assert.match(r.stderr, refusal);
      assert.equal(f.generation, 0); assert.ok(!f.users.has(BOOTSTRAP));
    } finally {await f.clean();}
  }
  // A first creation, and a held token Forgejo does not know.
  for (const [options, held] of [[{exists: false, valid: false}, null], [{valid: false}, entry]]) {
    const f = await fixture({shipped: true, repositories: false, ...options});
    try {
      const r = await f.run(held); assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), entry);
      assert.equal(f.generation, 1); assert.ok(!f.users.has(BOOTSTRAP));
      assert.ok(!f.requests.some(r => r.method === 'PUT'), 'no grant');
      await f.privateFiles();
    } finally {await f.clean();}
  }
});

test('a confirmed invalid or lost same-name token is recovered once and reused', async () => {
  for (const held of [null, {...entry, 'forgejo-api-token': 'fixture-invalid-token'}]) {
    const f = await fixture({valid: false, staleToken: true, staleBootstrap: true});
    try {
      const r = await f.run(held); assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), entry);
      assert.equal(f.generation, 1);
      assert.equal(f.requests.filter(r => r.method === 'DELETE').length, 1);
      assert.equal((await f.run(entry)).code, 0);
      assert.equal(f.generation, 1); assert.ok(!f.users.has(BOOTSTRAP));
      await f.privateFiles();
    } finally {await f.clean();}
  }
});

test('read failures, absent pods and broad identity rights cannot mint or claim success', async () => {
  for (const options of [{unreadable: true}, {apiFailure: true}, {absentPod: true}, {unrelated: true}, {unrelated: true, privateUnrelated: true}, {repoAdmin: true}, {badUser: {restricted: false}}, {ownerToken: true}]) {
    const f = await fixture(options);
    try {
      const r = await f.run(entry);
      assert.notEqual(r.code, 0, JSON.stringify(options));
      assert.equal(f.generation, 0);
      assert.ok(!r.stderr.includes(TOKEN));
      assert.ok(!f.users.has(BOOTSTRAP));
      await f.privateFiles();
    } finally {await f.clean();}
  }
});

test('missing Plane input fails before provisioning, while check/dry only observes', async () => {
  const f = await fixture({exists: false, granted: false});
  try {
    for (const value of [null, '']) {
      const r = await f.run(null, value);
      assert.notEqual(r.code, 0); assert.match(r.stderr, /plane-api-token/);
      assert.equal(f.commands.length, 0);
    }
    const r = await f.run(null, PLANE, '--check');
    assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {satisfied: false});
    assert.equal(f.generation, 0);
    assert.ok(f.commands.every(c => c.includes('get') || c.includes('list')));
    assert.ok(f.requests.every(r => r.method === 'GET'));
    await f.privateFiles();
  } finally {await f.clean();}
});

// Run 20261015T181634Z-3907389-2ef68b25 on the master: Vault held no forgejo-build entry, the run's
// answers carried no plane_api_token, and the check exited 1 with one line in 55 ms, before any
// cluster command (the fastest elevated microk8s call of that run took 141 ms).
test('a check with no held entry and no Plane answer refuses with exit 1 before any cluster command', async () => {
  const refusesFirst = async f => {
    const r = await f.run(null, null, '--check');
    return r.code === 1 && /plane-api-token is absent/.test(r.stderr) && r.stdout === '' && f.commands.length === 0;
  };
  const f = await fixture();
  try {
    assert.equal(await refusesFirst(f), true);
    // INNOCENT: with the answer the same check reads the pod and answers its verdict.
    const r = await f.run(null, PLANE, '--check');
    assert.equal(r.code, 0, r.stderr); assert.deepEqual(JSON.parse(r.stdout), {satisfied: false});
    assert.ok(f.commands[0].includes('pods'));
  } finally {await f.clean();}
  // PLANTED DEFECT: a producer that reads the pod before it holds the Plane input reaches the cluster.
  const early = await fixture({mutate: text => text.replace('def exchange():\n', 'def exchange():\n    ready_pod()\n')});
  try {
    assert.equal(await refusesFirst(early), false);
  } finally {await early.clean();}
});


test('cancellation removes temporary bootstrap authorization and keeps output and files private', async () => {
  const f = await fixture({valid: false, pause: true});
  try {
    const r = await f.run(null, PLANE, '--apply', true);
    assert.notEqual(r.code, 0);
    assert.ok(!f.users.has(BOOTSTRAP));
    assert.ok(!r.stderr.includes(PASSWORD) && !r.stderr.includes(TOKEN));
    await f.privateFiles();
  } finally {await f.clean();}
});
