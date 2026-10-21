import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {MODULE, CANARY, assertRefused, forgejoCommand, installation, planeExec, planeOutput, privateOutcome, program, rendered, root, unreadableInputs, writeProducer} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/forgejo-build-credentials.sh.tpl';
const USER = 'forgejo-build', BOOTSTRAP = 'forgejo-build-provisioner';
const REPO = 'akadmin/hostyour-release-test';
const PLANE = 'plane_api_fixture0forgejo0build0key';
const OWNER_KEY = 'plane_api_fixture0owner0key';
const TOKEN = 'fixture-forgejo-build-issued-secret';
const PASSWORD = "fixture-bootstrap-password'$with-quotes";
const entry = {'forgejo-user': USER, 'forgejo-api-token': TOKEN, 'plane-api-token': PLANE};
const WORKSPACE = 'simplidigita', LABEL = 'plane-update-status';
const PROJECTS = ['e5c01046-3739-4af7-abc4-3c13b28dd232', '7bbca0da-56a0-4c33-bf6d-aaef3eb327d1'];
const READ = '# forgejo-build read', WRITE = '# forgejo-build write';
const sha = text => createHash('sha256').update(text).digest('hex');
// A read of the cluster: a get, the Forgejo user list, or the read snippet in Plane's API pod.
const reads = c => c.includes('get') || c.includes('list') || (c.includes('manage.py') && c.at(-1).startsWith(READ + '\n'));

function wiring(steps) {
  const writers = steps.filter(s => s.path === '<stage>/app/forgejo-build');
  if (writers.length !== 1 || writers[0].step !== 'vault_kv_entry_from_command') return ['not one complete-entry writer'];
  const row = writers[0], problems = [];
  if (JSON.stringify(row.fields) !== JSON.stringify(Object.keys(entry))) problems.push('not the three credential fields');
  if (row.fields_from_answers !== undefined) problems.push('an answer stands in for a field');
  const render = steps.find(s => s.path === row.producer);
  const module = steps.find(s => s.template === MODULE);
  const machine = ['books_here_in_answers', 'build_plane_here_in_answers', 'plane_runs_here'];
  if (![row, render, module].every(r => machine.every(c => r?.when?.includes(c)))) problems.push('wrong machine');
  if (row.on_failure !== 'exit') problems.push('failure continued');
  if (render?.step !== 'write_file_from_template' || render.template !== TEMPLATE) problems.push('no application producer');
  if (module?.step !== 'write_file_from_template' || module.elevated !== true || module.file_mode !== 0o600 ||
      render?.values?.['forgejo-plane-access-module'] !== module.path) problems.push('the producer loads no private module');
  if (steps.indexOf(module) > steps.indexOf(render)) problems.push('the module after its producer');
  if (steps.indexOf(row) <= steps.findIndex(s => s.manifest === 'clusters/argocd/root-app.yaml')) problems.push('before Forgejo can start');
  return problems;
}

test('one installer writer follows the handoff, loads the private module and reads no answer', () => {
  assert.deepEqual(wiring(program.steps), []);
  // Conditions are measured before the first row, so a first installation finds no Plane yet.
  assert.deepEqual(installation.conditions.plane_runs_here, {predicate: 'kubernetes_object_present', kind: 'deployments.apps',
    name: 'plane-api-wl', namespace: 'plane', kubectl: ['microk8s', 'kubectl'], kubectl_needs_root: true});
  assert.equal(program.answers.find(a => a.name === 'plane_api_token'), undefined);
  const writer = steps => steps.find(s => s.path === '<stage>/app/forgejo-build');
  for (const defect of [
    steps => steps.push(structuredClone(writer(steps))),
    steps => { writer(steps).fields.push('plane-project'); },
    steps => { writer(steps).on_failure = 'continue'; },
    steps => { const row = writer(steps); row.when = row.when.filter(c => c !== 'plane_runs_here'); },
    steps => { const row = steps.find(s => s.template === TEMPLATE); row.when = row.when.filter(c => c !== 'plane_runs_here'); },
    steps => { writer(steps).fields_from_answers = ['plane-api-token=plane_api_token']; },
    steps => { steps.splice(steps.findIndex(s => s.template === MODULE), 1); },
    steps => { steps.push(...steps.splice(steps.findIndex(s => s.template === MODULE), 1)); },
    steps => { steps.find(s => s.template === MODULE).file_mode = 0o644; },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
  assert.deepEqual(wiring([...program.steps]), []);
});

test('the producer and its module render under the engine\'s slot rule with exactly their rows\' values', () => {
  const template = readFileSync(new URL(TEMPLATE, root), 'utf8'), module = readFileSync(new URL(MODULE, root), 'utf8');
  const {values} = program.steps.find(s => s.template === TEMPLATE);
  assert.ok(!rendered(template, values).match(/<[a-z][a-z0-9-]*\??>/));
  assert.equal(program.steps.find(s => s.template === MODULE).values, undefined);
  assert.ok(!rendered(module).match(/<[a-z][a-z0-9-]*\??>/));
  // PLANTED: an angle-bracketed word in a comment is a slot no row fills, and the engine refuses it.
  assert.throws(() => rendered(template.replace('# The installer', '# GET /users/<user>/tokens\n# The installer'), values), /unfilled <user>/);
  assert.throws(() => rendered(module.replace('# The access', '# GET /users/<user>\n# The access')), /unfilled <user>/);
  assert.throws(() => rendered(template, {...values, 'forgejo-planted': 'x'}), /unplaced forgejo-planted/);
});

const SCOPES = ['read:user', 'write:repository'];
const UNRELATED = 'akadmin/unrelated';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

// The deployed Pipeline forgejo-release as the producer reads it: its task plane names the targets.
const pipeline = targets => ({spec: {tasks: [{name: 'release'}, {name: 'plane', params: [
  {name: 'repository', value: '$(params.repository)'}, {name: 'plane-targets', value: targets}]}]}});
const TARGETS = JSON.stringify({workspace: WORKSPACE, projects: [{prefixes: ['ansiwise-'], id: PROJECTS[0]}, {prefixes: ['hostyour-'], id: PROJECTS[1]}]});

// A stand-in for the pinned Forgejo 15.0.10 routes the producer and a build call. It answers by the
// token's scopes, then the repository, then the user's right, in the order routers/api/v1/api.go
// checks them: a token needs write:<category> for POST, PUT and DELETE and read or write otherwise
// (api.go:252-260, permissions/token_requires_scopes.go:13-39); /user and /users/<name> need the user
// category (api.go:611, :760), /user/repos the repository category as well (api.go:722); public-only
// hides private repositories (services/authz/public_repos_reducer.go); basic auth carries no scope.
// Beside it a stand-in for Plane v1.4.2 answers the module's snippets by the semantics of their ORM
// statements, one transaction each, and answers the write snippet's calls from the committed rows.
async function fixture(options = {}) {
  const render = program.steps.find(s => s.template === TEMPLATE);
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-credentials-'));
  const commands = [], inputs = [], requests = [], snippets = [];
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
  const member = place => options.planeUser === false ? null : place in (options.planeRoles ?? {}) ?
    options.planeRoles[place] && {role: 15, is_active: true, ...options.planeRoles[place]} : {role: 15, is_active: true};
  const plane = {
    workspace: options.planeWorkspace === false ? null : WORKSPACE,
    projects: new Set(PROJECTS.filter(p => p !== options.missingProject)),
    user: options.planeUser === false ? null : {is_bot: true, is_active: true, instance_admin: false, ...options.planeUser},
    roles: Object.fromEntries(['workspace', ...PROJECTS].map(place => [place, member(place)])),
    tokens: options.planeTokens ?? (options.planeUser === false ? [] : [{owner: USER, label: LABEL, value: PLANE, is_active: true, expired: false}]),
    forbid: options.planeForbid ?? null,
    issued: 0,
  };
  const own = () => plane.tokens.filter(t => t.owner === USER && t.label === LABEL);
  const accepted = t => t.is_active && !t.expired && plane.user?.is_active === true;
  const planeAnswer = ({name, args}) => {
    assert.deepEqual([args.email, args.label], [USER + '@hostyour.invalid', LABEL]);
    const workspace = plane.workspace === args.workspace;
    const found = workspace ? args.projects.filter(p => plane.projects.has(p)) : [];
    if (name === READ) return {workspace, projects: found, user: plane.user && {
      is_bot: plane.user.is_bot, is_active: plane.user.is_active, instance_admin: plane.user.instance_admin,
      workspace: workspace ? plane.roles.workspace : null, projects: Object.fromEntries(found.map(p => [p, plane.roles[p]])),
      labeled: own().length, accepted: own().filter(accepted).map(t => sha(t.value))}};
    if (name !== WRITE) return undefined;
    // Every refusal of the snippet comes before its first write, as a rolled back block leaves nothing.
    const places = ['workspace', ...args.projects];
    if (!workspace || found.length !== args.projects.length) return undefined;
    if (plane.user && (!plane.user.is_bot || !plane.user.is_active || plane.user.instance_admin)) return undefined;
    if (plane.user && places.some(place => plane.roles[place]?.role > 15)) return undefined;
    if (args.issue ? own().length > 0 : !(own().length === 1 && accepted(own()[0]))) return undefined;
    plane.user ??= {is_bot: true, is_active: true, instance_admin: false};
    for (const place of places) plane.roles[place] = {role: 15, is_active: true};
    if (args.issue) plane.tokens.push({owner: USER, label: LABEL, value: 'plane_api_fixture0issued' + ++plane.issued, is_active: true, expired: false});
    const key = own()[0].value;
    const statuses = options.planeStatuses?.(args.projects) ?? Object.fromEntries(args.projects.map(p => [p, plane.forbid === p ? 403 : accepted(own()[0]) && plane.roles[p].is_active ? 200 : 401]));
    return Object.values(statuses).every(s => s === 200) ? {statuses, key} : {statuses};
  };
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname;
    const send = (status, data = '') => { res.writeHead(status, {'content-type': 'application/json'}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (path === '/_command') {
      const {argv, stdin} = JSON.parse(text); commands.push(argv); inputs.push(stdin);
      const exec = planeExec(argv);
      if (exec) {
        snippets.push(exec.name);
        if (options.planeDelay) await new Promise(resolve => setTimeout(resolve, options.planeDelay));
        if (exec.error) return send(500, exec.error);
        const value = planeAnswer(exec);
        return value === undefined ? send(500, 'Traceback (most recent call last): fixture refusal') : send(200, planeOutput(argv, value, options.framing));
      }
      if (argv.includes('pipelines.tekton.dev')) {
        assert.deepEqual(argv.slice(argv.indexOf('-n'), argv.indexOf('-n') + 2), ['-n', 'forgejo-build']);
        return options.pipeline === false ? send(500, 'NotFound') : send(200, pipeline(options.targets ?? TARGETS));
      }
      const args = argv.slice(argv.indexOf('--') + 1);
      if (args.slice(0, 4).join(' ') === 'forgejo admin user generate-access-token') {
        const name = args[args.indexOf('--username') + 1];
        assert.equal(args[args.indexOf('--token-name') + 1], USER);
        assert.ok(args.includes('--raw'));
        if ([...tokens.values()].some(t => t.owner === name && t.name === USER)) return send(500, 'same name exists');
        generation++; tokens.set(TOKEN, {owner: name, name: USER, scopes: args[args.indexOf('--scopes') + 1].split(','), repositories: null});
        return send(200, TOKEN + '\n');
      }
      const answered = forgejoCommand(argv, users, PASSWORD, options);
      return answered ? send(...answered) : send(500, TOKEN);
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
    if (path === '/api/v1/users/' + USER && req.method === 'GET') {
      if (!basic) return send(403);
      const u = users.get(USER);
      return u ? send(200, {login: USER, is_admin: u.admin, restricted: u.restricted, active: u.active}) : send(404);
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
  const clean = async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true});};
  let producer, kubectl;
  try {
    // The grant cases name the proof repository; `shipped` renders with the row's values as they are.
    ({producer, kubectl} = await writeProducer(directory, TEMPLATE, options.shipped ? render.values : {...render.values, 'forgejo-repositories': REPO},
      {mutate: options.mutate, mutateModule: options.mutateModule, port}));
  } catch (error) {await clean(); throw error;}
  const secrets = () => [PLANE, OWNER_KEY, TOKEN, PASSWORD, ...plane.tokens.map(t => t.value)];
  const run = (held, mode = '--apply', cancel = false, raw = undefined) => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, mode, '--', kubectl], {cwd: directory});
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', (code, signal) => { try { resolve(privateOutcome({code, signal, stdout, stderr}, secrets())); } catch (error) { reject(error); } });
    child.stdin.end(raw ?? JSON.stringify({entry: held, inputs: {}}));
    if (cancel) {
      const timer = setInterval(() => {
        if (users.has(BOOTSTRAP)) {clearInterval(timer); child.kill('SIGTERM');}
      }, 5);
      child.on('close', () => clearInterval(timer));
    }
  });
  // No file and no command's argv or stdin holds a credential: every Plane exec gets an empty stdin.
  const privateFiles = async () => {
    for (const file of await readdir(directory)) {
      const text = await readFile(join(directory, file), 'utf8');
      for (const secret of secrets()) assert.ok(!text.includes(secret), file + ' holds a credential');
    }
    for (const [i, args] of commands.entries()) {
      const carried = args.join(' ') + JSON.stringify(planeExec(args)?.args ?? null);
      for (const secret of secrets()) assert.ok(!carried.includes(secret) && !inputs[i].includes(secret));
    }
  };
  const write = (repo, token) => fetch(`http://127.0.0.1:${port}/api/v1/repos/${repo}/statuses/${SHA}`,
    {method: 'POST', headers: {authorization: 'token ' + token}, body: '{}'}).then(r => r.status);
  return {run, clean, privateFiles, write, users, tokens, commands, inputs, requests, snippets, plane, own, get generation() {return generation;}};
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
    assertRefused(r, /did not validate/);
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
      assertRefused(r, /unrelated repository/);
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
    const check = await f.run(standing, '--check');
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
    const check = await f.run(standing, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    const r = await f.run(standing);
    assertRefused(r, /unrelated repository/);
    assert.equal(r.stdout, '');
    assert.ok(!f.users.has(BOOTSTRAP));
    await f.privateFiles();
  } finally {await f.clean();}
});

test('valid credentials survive retries and later callers without minting or a Plane write', async () => {
  const f = await fixture();
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await f.run(entry);
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), entry);
    }
    assert.equal(f.generation, 0);
    assert.equal(f.commands.filter(c => c.includes('create') || c.includes('delete')).length, 0);
    assert.ok(!f.snippets.includes(WRITE));
    const before = f.requests.length, commands = f.commands.length;
    const check = await f.run(entry, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: true});
    assert.ok(f.requests.slice(before).every(r => r.method === 'GET'), 'a check only reads');
    assert.ok(f.commands.slice(commands).every(reads), 'a check only reads');
    await f.privateFiles();
  } finally {await f.clean();}
});

// Forgejo on the master holds no repository since 2026-10-17 01:39 UTC, when the proof repository
// was deleted; the row names none, so a valid held token with no write right anywhere is kept.
test('with Forgejo holding no repository, the row\'s values keep a valid held token without a write', async () => {
  // PLANTED DEFECT: a row that names a repository Forgejo does not hold fails as run 20261017T090957Z did.
  const named = await fixture({repositories: false});
  try {
    const check = await named.run(entry, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    const r = await named.run(entry);
    assert.equal(r.code, 1); assert.equal(r.stdout, '');
    assertRefused(r, /refused PUT \/repos\/akadmin\/hostyour-release-test\/collaborators\/forgejo-build with HTTP 404/);
    assert.ok(!named.users.has(BOOTSTRAP));
  } finally {await named.clean();}
  const f = await fixture({shipped: true, repositories: false});
  try {
    const check = await f.run(entry, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: true});
    const r = await f.run(entry); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), entry);
    assert.ok(f.requests.every(r => r.method === 'GET'), 'no PUT and no DELETE');
    assert.ok(f.commands.every(reads), 'no user created, no token generated and no Plane write');
    assert.equal(f.generation, 0); assert.ok(!f.users.has(BOOTSTRAP));
    await f.privateFiles();
  } finally {await f.clean();}
});

test('with no repository named, every write right is refused and a token not issued here is minted again', async () => {
  for (const [options, refusal] of [[{}, /unrelated repository/], [{repoAdmin: true}, /administration rights/]]) {
    const f = await fixture({shipped: true, ...options});
    try {
      const r = await f.run(entry);
      assertRefused(r, refusal);
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

// Criterion 5 of #82: a master without the entry gets the key from its own Plane, with no answer.
test('a master without the entry gets all three fields, the Plane key issued in Plane or reused there', async () => {
  const completes = async (options, mutate) => {
    const f = await fixture({exists: false, valid: false, ...options, mutate});
    try {
      const r = await f.run(null);
      const own = f.own();
      const done = r.code === 0 && own.length === 1 &&
        JSON.stringify(JSON.parse(r.stdout)) === JSON.stringify({...entry, 'plane-api-token': own[0].value});
      if (done) await f.privateFiles();
      return {done, issued: f.plane.issued, user: f.plane.user, roles: Object.values(f.plane.roles)};
    } finally {await f.clean();}
  };
  const fresh = await completes({planeUser: false});
  assert.equal(fresh.done, true);
  assert.equal(fresh.issued, 1);
  assert.deepEqual(fresh.user, {is_bot: true, is_active: true, instance_admin: false});
  assert.ok(fresh.roles.every(r => r.role === 15 && r.is_active));
  // INNOCENT: Plane already holds the labeled key, which is reused, with no second key.
  const reused = await completes({});
  assert.equal(reused.done, true); assert.equal(reused.issued, 0);
  // PLANTED DEFECTS: the refusal of a master without the entry, and an entry without the Plane key.
  assert.equal((await completes({planeUser: false}, text => text.replace("        refuse('the held Forgejo credential entry is unreadable')\n",
    "        refuse('the held Forgejo credential entry is unreadable')\n    if not entry:\n        refuse('plane-api-token is absent')\n"))).done, false);
  assert.equal((await completes({planeUser: false}, text => text.replace("    return {'forgejo-user': USER, 'forgejo-api-token': token, 'plane-api-token': key}\n",
    "    return {'forgejo-user': USER, 'forgejo-api-token': token}\n"))).done, false);
});

// Criterion 3 of #82, one case each: whose key, which role, which projects, which workspace.
test('forgejo-build becomes a Member of the Pipeline\'s targets and only its own labeled key is kept', async () => {
  const outcome = async (options, held = entry, mutate) => {
    const f = await fixture({...options, mutate});
    try {
      const check = await f.run(held, '--check');
      const r = await f.run(held);
      return {satisfied: check.code === 0 ? JSON.parse(check.stdout).satisfied : null, code: r.code, stdout: r.stdout, stderr: r.stderr,
        key: r.code === 0 ? JSON.parse(r.stdout)['plane-api-token'] : null, own: f.own(), plane: f.plane, written: f.snippets.includes(WRITE)};
    } finally {await f.clean();}
  };
  // INNOCENT: user, both memberships and the labeled key stand; the check is satisfied and nothing is written.
  const standing = await outcome({});
  assert.deepEqual([standing.satisfied, standing.code, standing.key, standing.written, standing.own.length], [true, 0, PLANE, false, 1]);

  // Another user's key in the entry, as the owner's key stands there today, is replaced by forgejo-build's own.
  const ownersKey = {planeTokens: [{owner: USER, label: LABEL, value: PLANE, is_active: true, expired: false},
    {owner: 'akadmin', label: LABEL, value: OWNER_KEY, is_active: true, expired: false}]};
  const replaced = await outcome(ownersKey, {...entry, 'plane-api-token': OWNER_KEY});
  assert.deepEqual([replaced.satisfied, replaced.code, replaced.key, replaced.own.length], [false, 0, PLANE, 1]);
  assert.deepEqual(replaced.plane.tokens.find(t => t.owner === 'akadmin'), ownersKey.planeTokens[1], 'no other key is changed');
  // PLANTED DEFECT: a producer that takes any held key as forgejo-build's.
  const anyKey = await outcome(ownersKey, {...entry, 'plane-api-token': OWNER_KEY}, text => text.replace(
    "isinstance(held, str) and\n                hashlib.sha256(held.encode()).hexdigest() == user['accepted'][0])", 'isinstance(held, str))'));
  assert.deepEqual([anyKey.satisfied, anyKey.key], [true, OWNER_KEY]);

  // A role below Member, or an inactive membership, is raised to an active Member.
  const asMember = text => text.replace("r['role'] == MEMBER and r['is_active'] is True", "r['role'] <= MEMBER");
  for (const planeRoles of [{workspace: {role: 5}}, {[PROJECTS[1]]: {role: 5}}, {[PROJECTS[0]]: {is_active: false}}]) {
    const raised = await outcome({planeRoles});
    assert.deepEqual([raised.satisfied, raised.code, raised.key, raised.own.length], [false, 0, PLANE, 1], JSON.stringify(planeRoles));
    assert.ok(Object.values(raised.plane.roles).every(r => r.role === 15 && r.is_active));
    // PLANTED DEFECT: a producer that leaves a role below Member, or an inactive one.
    assert.equal((await outcome({planeRoles}, entry, asMember)).satisfied, true);
  }

  // A role above Member refuses by name, before any write.
  for (const [planeRoles, place] of [[{workspace: {role: 20}}, 'workspace ' + WORKSPACE], [{[PROJECTS[1]]: {role: 20}}, 'project ' + PROJECTS[1]]]) {
    const above = await outcome({planeRoles});
    assert.deepEqual([above.satisfied, above.code, above.written], [null, 1, false]);
    assert.ok(above.stderr.includes('forgejo-build holds a Plane role above Member in ' + place + '; Plane was not changed'), above.stderr);
    // PLANTED DEFECT: a producer that accepts a role above Member.
    const accepted = await outcome({planeRoles}, entry, text => text.replace("held_role is not None and held_role['role'] > MEMBER", 'False'));
    assert.ok(accepted.written && !accepted.stderr.includes('above Member'));
  }

  // A named project without the membership gets it.
  const missing = await outcome({planeRoles: {[PROJECTS[1]]: null}});
  assert.deepEqual([missing.satisfied, missing.code, missing.plane.roles[PROJECTS[1]]], [false, 0, {role: 15, is_active: true}]);
  // PLANTED DEFECT: a producer that looks at the workspace membership alone.
  assert.equal((await outcome({planeRoles: {[PROJECTS[1]]: null}}, entry,
    text => text.replace("        roles.update({'project ' + p: user['projects'][p] for p in projects})\n", ''))).satisfied, true);

  // A Plane without the workspace or a named project refuses by its name and creates nothing.
  const unchecked = text => text.replace("        if seen['workspace'] is not True:\n", '        if False:\n')
    .replace("            if project not in seen['projects']:\n", '            if False:\n');
  for (const [options, refusal] of [[{planeWorkspace: false, planeUser: false}, 'Plane has no workspace simplidigita; create it in Plane, then redeploy'],
    [{missingProject: PROJECTS[1], planeUser: false}, 'Plane has no project ' + PROJECTS[1] + ' in workspace simplidigita; create it in Plane, then redeploy']]) {
    const absent = await outcome(options);
    assert.deepEqual([absent.satisfied, absent.code, absent.written, absent.plane.user, absent.plane.tokens], [null, 1, false, null, []]);
    assert.ok(absent.stderr.includes(refusal), absent.stderr);
    // PLANTED DEFECT: a producer that goes on to write on a Plane without them.
    assert.equal((await outcome(options, entry, unchecked)).written, true);
  }

  // A Plane user that is no active bot, or an instance administrator, and more than one labeled key
  // or an inactive or expired one (expired or inactive keys count), refuse by name and write nothing.
  for (const [options, refusal] of [
    [{planeUser: {is_bot: false}}, /is not an active bot without instance administration/],
    [{planeUser: {instance_admin: true}}, /is not an active bot without instance administration/],
    [{planeTokens: [{owner: USER, label: LABEL, value: PLANE, is_active: true, expired: false},
      {owner: USER, label: LABEL, value: 'plane_api_fixture0expired', is_active: true, expired: true}]}, /more than one key of forgejo-build labeled plane-update-status/],
    [{planeTokens: [{owner: USER, label: LABEL, value: PLANE, is_active: false, expired: false}]}, /labeled plane-update-status is inactive or expired/],
  ]) {
    const refused = await outcome(options);
    assert.deepEqual([refused.satisfied, refused.code, refused.written], [null, 1, false], JSON.stringify(options));
    assertRefused(refused, refusal);
  }
});

test('a call refused after the commit leaves the rows a correct apply holds, and the next apply reuses them', async () => {
  const held = {...entry, 'plane-api-token': OWNER_KEY};
  const rounds = async mutate => {
    const f = await fixture({planeUser: false, planeForbid: PROJECTS[1], mutate});
    try {
      const first = await f.run(held), again = await f.run(held);
      const before = {user: f.plane.user, own: f.own().length, issued: f.plane.issued};
      f.plane.forbid = null;
      const last = await f.run(held);
      await f.privateFiles();
      return {first, again, before, last, own: f.own(), issued: f.plane.issued};
    } finally {await f.clean();}
  };
  const refusal = 'Plane refused the key of forgejo-build for project ' + PROJECTS[1] + ': HTTP 403; the user, the memberships and the key stay in Plane';
  const shipped = await rounds();
  for (const r of [shipped.first, shipped.again]) {
    assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.ok(r.stderr.includes(refusal), r.stderr);
    assert.ok(!r.stderr.includes('plane_api_'), 'no key in the refusal');
  }
  assert.deepEqual(shipped.before, {user: {is_bot: true, is_active: true, instance_admin: false}, own: 1, issued: 1});
  assert.equal(shipped.last.code, 0, shipped.last.stderr);
  assert.equal(JSON.parse(shipped.last.stdout)['plane-api-token'], shipped.own[0].value);
  assert.deepEqual([shipped.own.length, shipped.issued], [1, 1], 'the rerun keeps the one key');
  // PLANTED DEFECTS: a producer that swallows the refused call and writes the held key, and one that
  // issues a key again on the rerun, which the write snippet refuses.
  const swallowed = await rounds(text => text.replace("    key = held_key if kept else plane_key(arguments, seen)\n",
    "    try:\n        key = held_key if kept else plane_key(arguments, seen)\n    except access.Refused:\n        key = held_key\n"));
  assert.equal(swallowed.first.code, 0);
  const reissued = await rounds(text => text.replace("issue=seen['user'] is None or seen['user']['labeled'] == 0", 'issue=not kept'));
  assert.notEqual(reissued.last.code, 0);
});

test('a check sends only the read snippet, and every exec quiets Django and carries no key', async () => {
  const quiet = argv => argv.includes('--no-imports') && argv[argv.indexOf('-v') + 1] === '0';
  const execs = f => f.commands.filter(c => c.includes('manage.py'));
  const f = await fixture({planeUser: false});
  try {
    const check = await f.run(null, '--check');
    assert.equal(check.code, 0, check.stderr); assert.deepEqual(JSON.parse(check.stdout), {satisfied: false});
    assert.deepEqual(f.snippets, [READ]);
    assert.ok(f.commands.every(reads));
    const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(f.snippets, [READ, READ, WRITE]);
    assert.ok(execs(f).every(quiet));
    assert.deepEqual(execs(f).map(c => c.slice(c.indexOf('-n'), c.indexOf('-c') + 2)), Array(3).fill(['-n', 'plane', 'exec', '-i', 'deploy/plane-api-wl', '-c', 'plane-api']));
    await f.privateFiles();
  } finally {await f.clean();}
  // PLANTED DEFECT: a producer that fetches the key before it knows it only checks.
  const early = await fixture({planeUser: false, mutate: text => text.replace("    if not APPLY:\n        return {'satisfied': kept",
    "    key = held_key if kept else plane_key(arguments, seen)\n    if not APPLY:\n        return {'satisfied': kept")});
  try {
    await early.run(null, '--check');
    assert.ok(early.snippets.includes(WRITE));
  } finally {await early.clean();}
  // PLANTED DEFECT: a shell that is not quieted; the banner it writes is read past all the same.
  const loud = await fixture({mutateModule: text => text.replace("'shell', '--no-imports', '-v', '0', '-c']", "'shell', '-c']")});
  try {
    const r = await loud.run(entry); assert.equal(r.code, 0, r.stderr);
    assert.ok(!execs(loud).every(quiet));
  } finally {await loud.clean();}
});

test('the one marked line is read past a log line, and a missing or doubled one refuses by name', async () => {
  const answered = async (framing, mutateModule) => {
    const f = await fixture({framing, mutateModule});
    try {return await f.run(entry, '--check');} finally {await f.clean();}
  };
  const logged = await answered('log');
  assert.equal(logged.code, 0, logged.stderr); assert.deepEqual(JSON.parse(logged.stdout), {satisfied: true});
  // PLANTED DEFECT: a reader that takes the last line.
  assert.notEqual((await answered('log', text => text.replace(
    '    lines = [line for line in result.stdout.splitlines() if line.startswith(MARK)]\n', '    lines = result.stdout.splitlines()[-1:]\n'))).code, 0);
  // PLANTED DEFECT: a snippet that reads a name it never defines, which Django's shell refuses.
  const typo = await fixture({mutate: text => text.replace('answer(seen())', 'answer(sen())')});
  try {
    const r = await typo.run(entry, '--check');
    assert.equal(r.code, 1); assertRefused(r, /the Plane pod command was refused; output withheld/);
  } finally {await typo.clean();}
  for (const framing of ['none', 'twice']) {
    const r = await answered(framing);
    assert.equal(r.code, 1); assert.equal(r.stdout, '');
    assertRefused(r, /the Plane pod answer could not be read; output withheld/);
  }
});

test('a Plane exec past its bound, an absent Pipeline and unreadable targets refuse by name', async () => {
  const bounded = text => text.replace('PLANE_EXEC_SECONDS = 30', 'PLANE_EXEC_SECONDS = 1');
  for (const [options, refusal] of [[{planeDelay: 3000, mutateModule: bounded}, /the Plane pod did not answer within its deadline/],
    [{pipeline: false}, /the Pipeline forgejo-release was refused; output withheld/],
    [{targets: JSON.stringify({workspace: WORKSPACE, projects: [{id: 'not-a-project-id'}]})}, /names no readable plane-targets in its task plane/],
    [{targets: '{'}, /names no readable plane-targets in its task plane/]]) {
    const f = await fixture(options);
    try {
      const r = await f.run(entry);
      assert.equal(r.code, 1); assert.equal(r.stdout, ''); assert.match(r.stderr, refusal);
      assert.ok(!f.snippets.includes(WRITE));
    } finally {await f.clean();}
  }
  // INNOCENT: the same bound with a prompt Plane.
  const f = await fixture({mutateModule: bounded});
  try {assert.equal((await f.run(entry)).code, 0);} finally {await f.clean();}
});

test('cancellation removes temporary bootstrap authorization and keeps output and files private', async () => {
  const f = await fixture({valid: false, pause: true});
  try {
    const r = await f.run(null, '--apply', true);
    assert.notEqual(r.code, 0);
    assert.ok(!f.users.has(BOOTSTRAP));
    assert.ok(!r.stderr.includes(PASSWORD) && !r.stderr.includes(TOKEN));
    await f.privateFiles();
  } finally {await f.clean();}
});

test('a producer handed input it cannot read refuses by name and repeats none of it', async () => {
  const f = await fixture();
  try {
    for (const [reason, raw] of unreadableInputs(CANARY)) assertRefused(await f.run(null, '--apply', false, raw), reason, [CANARY]);
  } finally {await f.clean();}
});

test('a status of Plane\'s answer that is no integer HTTP status is refused unread, and the key and the status are never echoed', async () => {
  // PLANTED DEFECTS: every shape that is no status in range, in the place of the first project's.
  for (const bad of [CANARY, {status: CANARY}, [CANARY], true, 99, 600, -1, 200.5, '200', 2 ** 70]) {
    const f = await fixture({planeUser: false, planeStatuses: projects => Object.fromEntries(projects.map((p, i) => [p, i === 0 ? bad : 200]))});
    try {
      const r = await f.run(null);
      assertRefused(r, 'the Plane pod answer could not be read; output withheld', [CANARY, 'plane_api_fixture0issued']);
      assert.equal(r.stdout, '', JSON.stringify(bad));
    } finally {await f.clean();}
  }
  // PLANTED INNOCENT: a status Plane's API gave, and no answer at all, are said as what they are.
  for (const [status, said] of [[403, 'HTTP 403'], [null, 'no answer']]) {
    const f = await fixture({planeUser: false, planeStatuses: projects => Object.fromEntries(projects.map((p, i) => [p, i === 0 ? status : 200]))});
    try {
      assertRefused(await f.run(null), new RegExp(`Plane refused the key of forgejo-build for project ${PROJECTS[0]}: ${said}; `), [CANARY]);
    } finally {await f.clean();}
  }
});
