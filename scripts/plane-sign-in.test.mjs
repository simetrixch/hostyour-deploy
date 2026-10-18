import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {MODULE, forgejoCommand, planeExec, planeOutput, program, rendered, root, writeProducer} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/plane-sign-in.sh.tpl';
const USER = 'plane', EMAIL = 'plane@hostyour.invalid', BOOTSTRAP = 'forgejo-build-provisioner';
const PASSWORD = "fixture-bootstrap-password'$with-quotes";
const FORGEJO = 'forgejo.master.fixture.invalid', PLANE = 'plane.master.fixture.invalid';
const REDIRECT = `https://${PLANE}/auth/gitea/callback/`;
const CLIENT = '0b3a2f0e-6c7d-4e59-9d1e-7a3f1c2b4d5e', SECRET = 'gto_fixture0held0client0secret';
// The third field names, by Forgejo's id, the accounts of a test address whose limits an apply has set; none yet.
const held = {'client-id': CLIENT, 'client-secret': SECRET, 'limited-user-ids': '[]'};
const READ = '# plane sign-in read', WRITE = '# plane sign-in write';
const ADMISSION_READ = '# plane sign-in admission read', ADMISSION_WRITE = '# plane sign-in admission write';
// The two Authentik accounts of the sign-in proof, as the test mailbox names them: the mailbox, a `+`, the
// case file's name without `.spec.ts` (digita-testkit packages/e2e/settings.ts testMailboxAddressOf). Only the
// first is invited to Plane's workspace.
const WORKSPACE = 'simplidigita', MEMBER = 15, ADMIN = 20, GUEST = 5;
// The installation's people are stand-ins: no address of a person stands in this repository, which is public.
const ADMINISTRATOR = 'administrator@installation.example.test';
const INVITED = 'simplidigita.ai+plane-sign-in@gmail.com', UNINVITED = 'simplidigita.ai+plane-sign-in-uninvited@gmail.com';
const LIMITS = {allow_create_organization: false, max_repo_creation: 0};
const PROJECT = '5b0c6a3e-3b1d-4e9a-8a11-0d6f9a7c2e41';
const STAND_IN = fileURLToPath(new URL('plane-orm-stand-in.py', import.meta.url));
const PROBE = ['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri'];
// The engine fills a slot from an answer (ansiwise-plugins write_file_from_template, KeyBinding.resolveIn): the list
// joined, and a slot whose answer holds nothing is left out, so a line with that optional slot is dropped.
const filled = (values, answers = {}) => Object.fromEntries(Object.entries(values).flatMap(([slot, source]) => {
  if (typeof source === 'string') return [[slot, source]];
  const text = (answers[source.answer] ?? []).join(source.join);
  return text === '' ? [] : [[slot, text]];
}));
const sha = text => createHash('sha256').update(text).digest('hex');
// Plane's settings as configure_instance leaves them from its defaults, and as this producer wants them.
const DEFAULTS = {IS_GITEA_ENABLED: '0', GITEA_HOST: '', GITEA_CLIENT_ID: '', GITEA_CLIENT_SECRET: '', ENABLE_SIGNUP: '1', ENABLE_EMAIL_PASSWORD: '1', ENABLE_MAGIC_LINK_LOGIN: '0'};
const signIn = (id, secret) => ({IS_GITEA_ENABLED: '1', GITEA_HOST: `https://${FORGEJO}`, GITEA_CLIENT_ID: id, GITEA_CLIENT_SECRET: secret, ENABLE_SIGNUP: '0', ENABLE_EMAIL_PASSWORD: '0', ENABLE_MAGIC_LINK_LOGIN: '0'});

const invitation = (id, email, role) => ({id, workspace_id: 1, email, accepted: true, role, token: 'fixture-invitation-token' + id});

function wiring(steps) {
  const writers = steps.filter(s => s.path === '<stage>/app/plane-sign-in');
  if (writers.length !== 1 || writers[0].step !== 'vault_kv_entry_from_command') return ['not one complete-entry writer'];
  const row = writers[0], problems = [];
  if (JSON.stringify(row.fields) !== JSON.stringify(['client-id', 'client-secret', 'limited-user-ids'])) problems.push('not the client fields and the limited accounts');
  if (row.fields_from_answers !== undefined) problems.push('an answer stands in for a field');
  const render = steps.find(s => s.path === row.producer);
  const module = steps.find(s => s.template === MODULE);
  const build = steps.find(s => s.template === 'ansiwise/templates/forgejo-build-credentials.sh.tpl');
  const machine = ['books_here_in_answers', 'build_plane_here_in_answers', 'plane_runs_here'];
  if (![row, render].every(r => machine.every(c => r?.when?.includes(c)))) problems.push('wrong machine');
  if (row.on_failure !== 'exit' || render?.on_failure !== 'exit') problems.push('failure continued');
  if (render?.step !== 'write_file_from_template' || render.template !== TEMPLATE || render.elevated !== true) problems.push('no producer');
  if (render?.values?.['forgejo-plane-access-module'] !== module?.path || steps.indexOf(module) > steps.indexOf(render)) problems.push('the producer loads no module');
  // One reserved temporary administrator, guarded by one lock, whichever producer creates it.
  for (const value of ['forgejo-bootstrap-user', 'forgejo-credential-lock', 'forgejo-namespace', 'forgejo-pod-selector', 'forgejo-container']) {
    if (render?.values?.[value] !== build?.values?.[value]) problems.push('another ' + value);
  }
  return problems;
}

test('one installer writer of the Plane client entry shares the module, the administrator and the lock', () => {
  assert.deepEqual(wiring(program.steps), []);
  const writer = steps => steps.find(s => s.path === '<stage>/app/plane-sign-in');
  const render = steps => steps.find(s => s.template === TEMPLATE);
  for (const defect of [
    steps => steps.push(structuredClone(writer(steps))),
    steps => { writer(steps).fields.push('plane-host'); },
    steps => { writer(steps).on_failure = 'continue'; },
    steps => { const row = writer(steps); row.when = row.when.filter(c => c !== 'plane_runs_here'); },
    steps => { render(steps).values['forgejo-credential-lock'] = '/run/plane-sign-in.lock'; },
    steps => { render(steps).values['forgejo-bootstrap-user'] = 'plane-provisioner'; },
    steps => { steps.push(...steps.splice(steps.findIndex(s => s.template === MODULE), 1)); },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
});

test('the producer renders under the engine\'s slot rule with exactly its row\'s values', () => {
  const template = readFileSync(new URL(TEMPLATE, root), 'utf8');
  const {values} = program.steps.find(s => s.template === TEMPLATE);
  assert.ok(!rendered(template, filled(values, {plane_further_people: ['person@installation.example.test member']})).match(/<[a-z][a-z0-9-]*\??>/));
  assert.ok(!rendered(template, filled(values)).match(/<[a-z][a-z0-9-]*\??>/));
  // PLANTED: an angle-bracketed word in a comment is a slot no row fills, and the engine refuses it.
  assert.throws(() => rendered(template.replace('# The installer', '# GET /users/<user>\n# The installer'), filled(values)), /unfilled <user>/);
  assert.throws(() => rendered(template, {...filled(values), 'forgejo-planted': 'x'}), /unplaced forgejo-planted/);
});

// A stand-in for the pinned Forgejo 15.0.10: its user CLI, the OAuth2 application API of a user
// (routers/api/v1/user/app.go: create returns the secret once, a list hides it, a PATCH regenerates
// it), the header Sudo for an administrator only (api.go sudo), and the token endpoint, which judges
// an authorization code in the order of routers/web/auth/oauth.go handleAuthorizationCode. Beside it
// a stand-in for Plane v1.4.2's InstanceConfiguration rows, which the snippets read and write.
async function fixture(options = {}) {
  const render = program.steps.find(s => s.template === TEMPLATE);
  const directory = await mkdtemp(join(tmpdir(), 'plane-sign-in-'));
  const commands = [], inputs = [], requests = [], snippets = [];
  const users = new Map([['akadmin', {email: ADMINISTRATOR, admin: true, restricted: false, active: true, ...options.akadmin}]]);
  if (options.planeUser !== false) users.set(USER, {email: EMAIL, admin: false, restricted: true, active: true, ...options.planeUser});
  if (options.staleBootstrap) users.set(BOOTSTRAP, {email: BOOTSTRAP + '@hostyour.invalid', admin: true, restricted: false, active: true});
  let next = 1;
  const apps = options.application === false ? [] : [{id: next++, name: 'plane', owner: USER, client_id: CLIENT, secret: SECRET,
    redirect_uris: [REDIRECT], confidential: true, ...options.application}];
  if (options.extraApplication) apps.push({id: next++, name: 'other', owner: USER, client_id: randomUUID(), secret: 'gto_fixture0other', redirect_uris: ['https://elsewhere.invalid/'], confidential: true});
  const settings = new Map(Object.entries(options.planeSettings ?? (options.planeHolds === false ? DEFAULTS : signIn(CLIENT, SECRET))));
  for (const [name, account] of Object.entries(options.accounts ?? {})) users.set(name, {admin: false, restricted: true, active: true, ...account});
  // Plane's workspace tables, as the stand-in ORM keeps them: the owner's membership and, by default, the
  // invitation of the test account.
  const planeFile = join(directory, 'plane-orm.json');
  writeFileSync(planeFile, JSON.stringify(options.plane ?? {workspaces: options.workspace === false ? [] : [{id: 1, slug: WORKSPACE}],
    users: [{id: 1, email: 'owner@example.invalid'}], members: [{workspace_id: 1, member_id: 1, role: 20, is_active: true}],
    invites: options.invited === false ? [] : [invitation(1, INVITED, MEMBER), invitation(2, ADMINISTRATOR, ADMIN)]}));
  const admission = () => JSON.parse(readFileSync(planeFile, 'utf8'));
  const limits = new Map();
  let changes = 0;
  const ingresses = {forgejo: options.forgejoIngresses ?? [{spec: {rules: [{host: FORGEJO, http: {}}]}}], plane: {spec: {rules: [{host: PLANE}, {host: PLANE}]}}};
  const planeAnswer = ({name, args}, stdin) => {
    const stored = () => Object.fromEntries(args.keys.filter(k => settings.has(k)).map(k => [k, k === 'GITEA_CLIENT_SECRET' ? sha(settings.get(k)) : settings.get(k)]));
    if (name === READ) return stored();
    if (name !== WRITE) return undefined;
    const wanted = {...args.settings, GITEA_CLIENT_SECRET: stdin};
    if (Object.keys(wanted).some(k => !settings.has(k))) return undefined;
    for (const [key, value] of Object.entries(wanted)) if (settings.get(key) !== value) { settings.set(key, value); changes++; }
    return stored();
  };
  const listed = a => ({id: a.id, name: a.name, client_id: a.client_id, client_secret: '', confidential_client: a.confidential, redirect_uris: a.redirect_uris, created: '2026-10-17T00:00:00Z'});
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const url = new URL(req.url, 'http://fixture.invalid'), path = url.pathname;
    const send = (status, data = '') => { res.writeHead(status, {'content-type': 'application/json'}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (path === '/_command') {
      const {argv, stdin} = JSON.parse(text); commands.push(argv); inputs.push(stdin);
      const exec = planeExec(argv);
      if (exec) {
        snippets.push(exec.name);
        if (exec.error) return send(500, exec.error);
        if (exec.name === ADMISSION_READ || exec.name === ADMISSION_WRITE) {
          assert.deepEqual(Object.keys(exec.args).sort(), ['people', 'workspace']);
          try {
            return send(200, execFileSync('python3', ['-I', STAND_IN, planeFile], {input: argv.at(-1), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe']}));
          } catch (failure) {
            return send(500, 'Traceback (most recent call last): ' + failure.stderr);
          }
        }
        const value = planeAnswer(exec, stdin);
        return value === undefined ? send(500, 'Traceback (most recent call last): fixture refusal') : send(200, planeOutput(argv, value));
      }
      if (argv.includes('pipelines.tekton.dev')) {
        const targets = options.targets ?? JSON.stringify({workspace: WORKSPACE, projects: [{id: PROJECT}]});
        return send(200, {spec: {tasks: [{name: 'plane', params: [{name: 'plane-targets', value: targets}]}]}});
      }
      if (argv.includes('ingress')) {
        const namespace = argv[argv.indexOf('-n') + 1];
        if (namespace === 'plane') return argv.includes('plane-ingress') ? send(200, ingresses.plane) : send(500, 'NotFound');
        return send(200, {items: ingresses[namespace] ?? []});
      }
      const answered = forgejoCommand(argv, users, PASSWORD, options);
      return answered ? send(...answered) : send(500, 'unexpected command');
    }
    requests.push({method: req.method, path, body: text, authorization: req.headers.authorization, sudo: req.headers.sudo});
    if (path === '/login/oauth/access_token' && req.method === 'POST') {
      const form = new URLSearchParams(text);
      assert.deepEqual([...form.keys()].sort(), PROBE);
      assert.deepEqual([form.get('grant_type'), form.get('redirect_uri')], ['authorization_code', REDIRECT]);
      const app = apps.find(a => a.client_id === form.get('client_id'));
      const refused = (error, description) => send(400, {error, error_description: description});
      if (!app) return refused('invalid_client', `cannot load client with client id: '${form.get('client_id')}'`);
      if (app.confidential && form.get('client_secret') !== app.secret) return refused('unauthorized_client', 'invalid client secret');
      if (!app.redirect_uris.includes(form.get('redirect_uri'))) return refused('unauthorized_client', 'unexpected redirect URI');
      return refused('unauthorized_client', 'client is not authorized');
    }
    const basic = req.headers.authorization === 'Basic ' + Buffer.from(BOOTSTRAP + ':' + PASSWORD).toString('base64') && users.get(BOOTSTRAP)?.admin;
    if (!basic) return send(401);
    const limited = path.match(/^\/api\/v1\/admin\/users\/([^/]+)$/)?.[1];
    if (limited !== undefined && req.method === 'PATCH') {
      if (!users.has(limited)) return send(404);
      limits.set(limited, JSON.parse(text));
      return send(200, {login: limited});
    }
    if (req.headers.sudo !== USER || !users.has(USER)) return send(404);
    const mine = apps.filter(a => a.owner === USER);
    if (path === '/api/v1/user/applications/oauth2' && req.method === 'GET') {
      const page = Number(url.searchParams.get('page'));
      return send(200, mine.slice((page - 1) * 50, page * 50).map(listed));
    }
    const made = (status, app) => send(status, {...listed(app), client_secret: app.secret});
    const body = req.method === 'GET' ? null : JSON.parse(text);
    if (body) assert.deepEqual(Object.keys(body).sort(), ['confidential_client', 'name', 'redirect_uris']);
    if (path === '/api/v1/user/applications/oauth2' && req.method === 'POST') {
      const app = {id: next++, name: body.name, owner: USER, client_id: randomUUID(), secret: 'gto_fixture0issued' + next, redirect_uris: body.redirect_uris, confidential: body.confidential_client};
      apps.push(app);
      return made(201, app);
    }
    const id = path.match(/^\/api\/v1\/user\/applications\/oauth2\/(\d+)$/)?.[1];
    const app = mine.find(a => String(a.id) === id);
    if (app && req.method === 'PATCH') {
      Object.assign(app, {name: body.name, redirect_uris: body.redirect_uris, confidential: body.confidential_client, secret: 'gto_fixture0regenerated' + next++});
      return made(200, app);
    }
    return send(500, 'unexpected path');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const clean = async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true});};
  let producer, kubectl;
  try {
    ({producer, kubectl} = await writeProducer(directory, TEMPLATE, filled(render.values, options.answers), {mutate: options.mutate, port}));
  } catch (error) {await clean(); throw error;}
  const stderrs = [];
  const run = (entry, mode = '--apply') => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, mode, '--', kubectl], {cwd: directory});
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => { stderrs.push(stderr); resolve({code, stdout, stderr, entry: code === 0 ? JSON.parse(stdout) : null}); });
    child.stdin.end(JSON.stringify({entry, inputs: {}}));
  });
  // Forgejo accepts this client id and secret: a confidential application of user plane with our redirect URI.
  const accepts = (id, secret) => apps.some(a => a.owner === USER && a.client_id === id && a.confidential && a.secret === secret &&
    JSON.stringify(a.redirect_uris) === JSON.stringify([REDIRECT]));
  // A client secret stands only in the stdin of the write snippet and in the producer's stdout: in no
  // file, no argument (the snippet's arguments decoded included), no other stdin and no stderr.
  const privateSecrets = async () => {
    const secrets = [SECRET, PASSWORD, ...apps.map(a => a.secret)];
    for (const file of await readdir(directory)) {
      const text = await readFile(join(directory, file), 'utf8');
      for (const secret of secrets) assert.ok(!text.includes(secret), file + ' holds a secret');
    }
    for (const [i, argv] of commands.entries()) {
      const carried = argv.join(' ') + JSON.stringify(planeExec(argv)?.args ?? null);
      for (const secret of secrets) {
        assert.ok(!carried.includes(secret), 'an argument carries a secret');
        if (planeExec(argv)?.name !== WRITE) assert.ok(!inputs[i].includes(secret), 'a stdin other than the write snippet\'s carries a secret');
      }
    }
    for (const stderr of stderrs) for (const secret of secrets) assert.ok(!stderr.includes(secret), 'stderr carries a secret');
  };
  return {run, clean, accepts, privateSecrets, users, apps, settings, limits, admission, commands, inputs, requests, snippets, get changes() {return changes;}};
}

// A check that only reads: GETs, the two probes and nothing else to Forgejo, no administrator, no
// Sudo, and only gets, the user list and the read snippet in the cluster.
const onlyReads = (f, from = {requests: 0, commands: 0}) => {
  const requests = f.requests.slice(from.requests), commands = f.commands.slice(from.commands);
  return requests.every(r => r.method === 'GET' || (r.method === 'POST' && r.path === '/login/oauth/access_token')) &&
    requests.filter(r => r.method === 'POST').length <= 2 && requests.every(r => r.sudo === undefined && !r.authorization?.startsWith('Basic ')) &&
    commands.every(c => c.includes('get') || c.includes('list') || (c.includes('manage.py') &&
      [READ, ADMISSION_READ].some(name => c.at(-1).startsWith(name + '\n'))));
};
const mark = f => ({requests: f.requests.length, commands: f.commands.length});
const state = f => JSON.stringify({users: [...f.users], apps: f.apps, settings: [...f.settings], limits: [...f.limits], admission: f.admission()});

test('a first apply creates user plane and its one confidential application and turns every other sign-in off', async () => {
  const first = async mutate => {
    // Plane's defaults with magic code turned on in /god-mode, so every other sign-in starts on.
    const f = await fixture({planeUser: false, application: false, planeSettings: {...DEFAULTS, ENABLE_MAGIC_LINK_LOGIN: '1'}, mutate});
    try {
      const check = await f.run(null, '--check');
      assert.deepEqual([check.code, check.entry], [0, {satisfied: false}], check.stderr);
      const r = await f.run(null);
      return {r, f, settings: Object.fromEntries(f.settings), apps: [...f.apps], user: f.users.get(USER), done: r.code === 0 && await f.privateSecrets() === undefined};
    } finally {await f.clean();}
  };
  const {r, settings, apps, user, done} = await first();
  assert.equal(done, true, r.stderr);
  assert.equal(apps.length, 1);
  assert.deepEqual({name: apps[0].name, confidential: apps[0].confidential, redirect_uris: apps[0].redirect_uris}, {name: 'plane', confidential: true, redirect_uris: [REDIRECT]});
  assert.deepEqual(r.entry, {'client-id': apps[0].client_id, 'client-secret': apps[0].secret, 'limited-user-ids': '[]'});
  assert.deepEqual(settings, signIn(apps[0].client_id, apps[0].secret));
  assert.deepEqual(user, {email: EMAIL, admin: false, restricted: true, active: true});
  // PLANTED DEFECTS: a producer that leaves open sign-up, the password sign-in or magic code on.
  for (const key of ['ENABLE_SIGNUP', 'ENABLE_EMAIL_PASSWORD', 'ENABLE_MAGIC_LINK_LOGIN']) {
    const left = await first(text => text.replace(`'${key}': '0', `, '').replace(`, '${key}': '0'`, ''));
    assert.equal(left.settings[key], '1', key);
  }
});

test('a check of a complete state only reads and is satisfied, and apply on it writes nothing', async () => {
  const f = await fixture();
  try {
    const before = state(f);
    const check = await f.run(held, '--check');
    assert.deepEqual([check.code, check.entry], [0, {satisfied: true}], check.stderr);
    assert.ok(onlyReads(f));
    assert.equal(f.requests.filter(r => r.path === '/login/oauth/access_token').length, 2, 'two probes');
    assert.equal(state(f), before, 'the fake Forgejo and Plane changed no state');
    assert.deepEqual(f.snippets, [READ, ADMISSION_READ]);
    const r = await f.run(held);
    assert.deepEqual([r.code, r.entry], [0, held], r.stderr);
    assert.ok(!f.requests.some(q => q.path.startsWith('/api/v1/user/applications/oauth2') && q.method !== 'GET'), 'no application write');
    assert.equal(f.changes, 0, 'no Plane setting write');
    assert.equal(state(f), before);
    await f.privateSecrets();
  } finally {await f.clean();}
  // PLANTED DEFECT: a check that creates the user it misses.
  const writing = await fixture({planeUser: false, mutate: text => text.replace('    if not APPLY:\n        # Blind',
    "    if person is None:\n        access.cli(['create', '--username', USER, '--email', EMAIL, '--restricted', '--random-password', '--must-change-password=false'])\n    if not APPLY:\n        # Blind")});
  try {
    await writing.run(held, '--check');
    assert.ok(!onlyReads(writing) && writing.users.has(USER));
  } finally {await writing.clean();}
});

test('magic code turned on in Plane is no answer for a check, and apply turns it off again', async () => {
  const drift = async mutate => {
    const f = await fixture({planeSettings: {...signIn(CLIENT, SECRET), ENABLE_MAGIC_LINK_LOGIN: '1'}, mutate});
    try {
      const check = await f.run(held, '--check');
      const r = await f.run(held);
      return {satisfied: check.entry?.satisfied, r, magic: f.settings.get('ENABLE_MAGIC_LINK_LOGIN')};
    } finally {await f.clean();}
  };
  const shipped = await drift();
  assert.deepEqual([shipped.satisfied, shipped.r.code, shipped.r.entry, shipped.magic], [false, 0, held, '0'], shipped.r.stderr);
  // PLANTED DEFECT: a producer that no longer turns magic code off.
  const left = await drift(text => text.replace(", 'ENABLE_MAGIC_LINK_LOGIN': '0'", ''));
  assert.deepEqual([left.satisfied, left.magic], [true, '1']);
});

test('an application that takes no secret is no answer for a check, and apply makes it confidential', async () => {
  const outcome = async mutate => {
    const f = await fixture({application: {confidential: false}, mutate});
    try {
      const check = await f.run(held, '--check');
      const r = await f.run(held);
      return {satisfied: check.entry?.satisfied, r, accepted: r.entry && f.accepts(r.entry['client-id'], r.entry['client-secret']), plane: f.settings.get('GITEA_CLIENT_SECRET')};
    } finally {await f.clean();}
  };
  const shipped = await outcome();
  assert.equal(shipped.satisfied, false);
  assert.equal(shipped.accepted, true, shipped.r.stderr);
  assert.notEqual(shipped.r.entry['client-secret'], SECRET);
  assert.equal(shipped.plane, shipped.r.entry['client-secret']);
  // PLANTED DEFECT: a producer without probe 2.
  assert.equal((await outcome(text => text.replace('        second = probe(client_id, secrets.token_urlsafe(32), redirect)\n', '        return True\n'))).satisfied, true);
});

test('a secret Forgejo refuses is replaced, and Plane holds the entry\'s secret', async () => {
  // Forgejo holds another secret for the held client, as after a regeneration elsewhere.
  const refused = async mutate => {
    const f = await fixture({application: {secret: 'gto_fixture0current'}, mutate});
    try {
      const check = await f.run(held, '--check');
      const r = await f.run(held);
      return {satisfied: check.entry?.satisfied, r, accepted: r.entry && f.accepts(r.entry['client-id'], r.entry['client-secret']), plane: f.settings.get('GITEA_CLIENT_SECRET')};
    } finally {await f.clean();}
  };
  const shipped = await refused();
  assert.deepEqual([shipped.satisfied, shipped.accepted, shipped.r.entry['client-id']], [false, true, CLIENT], shipped.r.stderr);
  assert.equal(shipped.plane, shipped.r.entry['client-secret']);
  // PLANTED DEFECT: a producer that keeps the held secret once the listing matches, without the probes.
  const kept = await refused(text => text.replace(" and \\\n            confidential(held['client-id'], held['client-secret'], redirect):", ':'));
  assert.equal(kept.accepted, false);

  // Plane holds a secret other than the entry's, which Forgejo accepts: only Plane is written.
  const other = async mutate => {
    const f = await fixture({planeSettings: signIn(CLIENT, 'gto_fixture0stale'), mutate});
    try {
      const check = await f.run(held, '--check');
      const r = await f.run(held);
      return {satisfied: check.entry?.satisfied, r, plane: f.settings.get('GITEA_CLIENT_SECRET'), forgejo: f.requests.filter(q => q.method === 'PATCH' || (q.method === 'POST' && q.path !== '/login/oauth/access_token')).length};
    } finally {await f.clean();}
  };
  const fixed = await other();
  assert.deepEqual([fixed.satisfied, fixed.r.code, fixed.plane, fixed.forgejo], [false, 0, SECRET, 0], fixed.r.stderr);
  // PLANTED DEFECT: a producer that compares every Plane setting but the secret.
  assert.equal((await other(text => text.replace('            stored.get(SECRET) == hashlib.sha256(secret.encode()).hexdigest())', '            True)'))).satisfied, true);
});

test('a missing application is created once, and a rerun keeps it and creates no second', async () => {
  const reruns = async mutate => {
    const f = await fixture({application: false, mutate});
    try {
      const check = await f.run(held, '--check');
      const first = await f.run(held), again = await f.run(first.entry);
      const last = await f.run(again.entry, '--check');
      return {satisfied: check.entry?.satisfied, first, again, last, apps: f.apps.length, accepted: f.accepts(again.entry?.['client-id'], again.entry?.['client-secret'])};
    } finally {await f.clean();}
  };
  const shipped = await reruns();
  assert.equal(shipped.satisfied, false);
  assert.equal(shipped.first.code, 0, shipped.first.stderr);
  assert.deepEqual(shipped.again.entry, shipped.first.entry);
  assert.deepEqual([shipped.apps, shipped.accepted, shipped.last.entry?.satisfied], [1, true, true]);
  // PLANTED DEFECT: a producer that creates the application on every apply.
  assert.equal((await reruns(text => text.replace('    if not listed:\n', '    if True:\n'))).apps, 2);
});

test('apply refuses a plane user with administration rights or of another kind, and a second application', async () => {
  for (const [options, refusal] of [
    [{planeUser: {admin: true}}, /the Forgejo user plane is not the active non-admin machine user plane@hostyour.invalid/],
    [{planeUser: {active: false}}, /the Forgejo user plane is not the active non-admin machine user/],
    [{planeUser: {email: 'someone@example.invalid'}}, /the Forgejo user plane is not the active non-admin machine user/],
    [{extraApplication: true, planeHolds: false}, /Forgejo user plane holds an OAuth2 application beside one named plane/],
    [{forgejoIngresses: []}, /namespace forgejo holds no single Ingress with one host/],
    [{forgejoIngresses: [{spec: {rules: [{host: FORGEJO}, {host: 'git.' + FORGEJO}]}}]}, /namespace forgejo holds no single Ingress with one host/],
  ]) {
    const f = await fixture(options);
    try {
      const before = state(f);
      const r = await f.run(held);
      assert.equal(r.code, 1, JSON.stringify(options)); assert.equal(r.stdout, ''); assert.match(r.stderr, refusal);
      assert.equal(state(f), before, 'nothing changed');
      assert.ok(!f.users.has(BOOTSTRAP));
    } finally {await f.clean();}
  }
  // PLANTED DEFECT: a producer that accepts a plane user with administration rights.
  const f = await fixture({planeUser: {admin: true}, mutate: text => text.replace("person['email'] != EMAIL or person['admin'] or", "person['email'] != EMAIL or")});
  try {assert.equal((await f.run(held)).code, 0);} finally {await f.clean();}
});

test('apply restores our one redirect URI, which the check cannot see beside it, and removes a stale administrator', async () => {
  const f = await fixture({application: {redirect_uris: [REDIRECT, 'https://elsewhere.invalid/callback']}, staleBootstrap: true});
  try {
    // The check sees the stale administrator, never the second redirect URI.
    assert.deepEqual((await f.run(held, '--check')).entry, {satisfied: false});
    f.users.delete(BOOTSTRAP);
    assert.deepEqual((await f.run(held, '--check')).entry, {satisfied: true});
    f.users.set(BOOTSTRAP, {email: BOOTSTRAP + '@hostyour.invalid', admin: true, restricted: false, active: true});
    const r = await f.run(held);
    assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(f.apps[0].redirect_uris, [REDIRECT]);
    assert.equal(f.accepts(r.entry['client-id'], r.entry['client-secret']), true);
    assert.equal(f.settings.get('GITEA_CLIENT_SECRET'), r.entry['client-secret']);
    assert.ok(!f.users.has(BOOTSTRAP));
    await f.privateSecrets();
  } finally {await f.clean();}
});

test('the client secret goes in on the write snippet\'s stdin alone, never in its arguments', async () => {
  // PLANTED DEFECT: the secret among the snippet's arguments; the write snippet refuses the unknown
  // setting, and the privacy check finds the secret in the decoded arguments.
  const f = await fixture({planeHolds: false, mutate: text => text.replace("{'settings': wanted, 'keys': KEYS}, stdin=secret)",
    "{'settings': dict(wanted, secret=secret), 'keys': KEYS}, stdin=secret)")});
  try {
    await f.run(held);
    await assert.rejects(f.privateSecrets(), /an argument carries a secret/);
  } finally {await f.clean();}
});

// THE TEST ACCOUNTS of the sign-in proof (digita-testkit cases/plane-sign-in.spec.ts). The producer
// takes their two addresses from its row and invites the first alone: the second is the account Plane
// must refuse. Both are addresses of a case in the one test mailbox, never the bare mailbox, which is the
// owner's own.
// A planted defect that finds no text to change would plant nothing, and its test would pass on the shipped producer.
const swap = (from, to) => text => { assert.ok(text.includes(from), 'the producer no longer holds ' + from); return text.replace(from, to); };
const MAILBOX = /^simplidigita\.ai\+[a-z0-9]+(-[a-z0-9]+)*@gmail\.com$/;
function addressFindings(values) {
  const found = [], invited = values['plane-test-account-email'], uninvited = values['plane-test-uninvited-email'];
  for (const [name, address] of [['invited', invited], ['uninvited', uninvited]]) {
    if (!MAILBOX.test(address ?? '')) found.push(`the ${name} address ${address} is not an address of a case in the test mailbox`);
  }
  if (invited === uninvited) found.push('one address is both invited and uninvited');
  return found;
}

test('the row hands the producer the two test addresses of the sign-in proof', () => {
  const {values} = program.steps.find(s => s.template === TEMPLATE);
  assert.deepEqual([values['plane-test-account-email'], values['plane-test-uninvited-email']], [INVITED, UNINVITED]);
  assert.deepEqual(addressFindings(values), []);
  // PLANTED DEFECTS: the owner's bare mailbox, an address of another mailbox, and one address for both.
  for (const planted of [{'plane-test-account-email': 'simplidigita.ai@gmail.com'}, {'plane-test-uninvited-email': 'someone@example.invalid'},
    {'plane-test-uninvited-email': INVITED}]) {
    assert.notDeepEqual(addressFindings({...values, ...planted}), [], JSON.stringify(planted));
  }
});

test('apply invites the test account to the workspace as a Member and not the uninvited one, once, and a check only reads', async () => {
  const outcome = async (mutate, options = {}) => {
    const f = await fixture({invited: false, mutate, ...options});
    try {
      const before = state(f);
      const check = await f.run(held, '--check');
      assert.ok(onlyReads(f));
      assert.equal(state(f), before, 'a check changed state');
      const first = await f.run(held), second = await f.run(held);
      const after = await f.run(held, '--check');
      const invites = f.admission().invites;
      return {check: check.entry, first, second, after: after.entry, invites, stdout: first.stdout + second.stdout, stderr: first.stderr + second.stderr,
        written: f.snippets.filter(name => name === ADMISSION_WRITE).length};
    } finally {await f.clean();}
  };
  const shipped = await outcome();
  assert.deepEqual(shipped.check, {satisfied: false});
  assert.deepEqual([shipped.first.code, shipped.second.code, shipped.first.entry], [0, 0, held], shipped.first.stderr + shipped.second.stderr);
  assert.deepEqual(shipped.invites.map(({email, accepted, role, workspace_id}) => ({email, accepted, role, workspace_id})),
    [{email: INVITED, accepted: true, role: MEMBER, workspace_id: 1}, {email: ADMINISTRATOR, accepted: true, role: ADMIN, workspace_id: 1}],
    'one accepted Member invitation for the test account, and the administrator\'s, and no invitation for the uninvited address');
  assert.deepEqual(shipped.after, {satisfied: true});
  // The token of an invitation joins its holder to the workspace: made in Plane's pod from a random source, never from the
  // address, and never on any output of the producer.
  for (const {token} of shipped.invites) {
    assert.ok(token.length >= 32 && !token.includes('simplidigita') && !token.includes('example') && !(shipped.stdout + shipped.stderr).includes(token));
  }
  // PLANTED DEFECT: the other address invited.
  const wrong = await outcome(swap("wanted = {INVITED.lower(): ROLES['member']}", "wanted = {UNINVITED.lower(): ROLES['member']}"));
  assert.ok(wrong.invites.some(({email}) => email === UNINVITED) && !wrong.invites.some(({email}) => email === INVITED));
  // PLANTED DEFECT: an invitation that is not accepted turns into no membership; the write's own answer says so.
  const unaccepted = await outcome(swap("accepted=True,\n                                                     role=person['role']", "accepted=False,\n                                                     role=person['role']"));
  assert.equal(unaccepted.first.code, 1);
  assert.match(unaccepted.first.stderr, /Plane did not keep the invitation of the test account or of a person of the installation/);
  // PLANTED INNOCENT: the same addresses are members already (they signed in, which deleted the invitations): nothing is written.
  const member = await outcome(undefined, {plane: {workspaces: [{id: 1, slug: WORKSPACE}], users: [{id: 1, email: 'owner@example.invalid'}, {id: 2, email: INVITED}, {id: 3, email: ADMINISTRATOR}],
    members: [{workspace_id: 1, member_id: 1, role: 20, is_active: true}, {workspace_id: 1, member_id: 2, role: MEMBER, is_active: true}, {workspace_id: 1, member_id: 3, role: ADMIN, is_active: true}], invites: []}});
  assert.deepEqual([member.check, member.first.code, member.invites], [{satisfied: true}, 0, []]);
});

test('an invitation that is not accepted or not a Member is corrected in place, and a missing workspace is refused', async () => {
  const stale = {...invitation(1, INVITED, GUEST), accepted: false};
  const corrected = async mutate => {
    const f = await fixture({mutate, plane: {workspaces: [{id: 1, slug: WORKSPACE}], users: [{id: 1, email: 'owner@example.invalid'}],
      members: [{workspace_id: 1, member_id: 1, role: 20, is_active: true}], invites: [stale, invitation(2, ADMINISTRATOR, ADMIN)]}});
    try {
      const check = await f.run(held, '--check'), r = await f.run(held);
      return {check: check.entry, r, invites: f.admission().invites};
    } finally {await f.clean();}
  };
  const shipped = await corrected();
  assert.deepEqual([shipped.check, shipped.r.code], [{satisfied: false}, 0], shipped.r.stderr);
  assert.deepEqual(shipped.invites, [{...stale, accepted: true, role: MEMBER}, invitation(2, ADMINISTRATOR, ADMIN)]);
  // PLANTED DEFECT: a producer that makes a second invitation beside the stale one, which Plane's constraint refuses.
  assert.equal((await corrected(swap('if invite is None:', 'if True:'))).r.code, 1);
  const f = await fixture({workspace: false});
  try {
    assert.deepEqual((await f.run(held, '--check')).entry, {satisfied: false});
    const r = await f.run(held);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Plane has no workspace simplidigita; create it in Plane, then redeploy/);
  } finally {await f.clean();}
});

test('a Forgejo account of a test address is limited to no repositories and no organizations, and none may administer', async () => {
  const accounts = {'plane-sign-in': {email: INVITED}, 'plane-sign-in-uninvited': {email: UNINVITED}, someone: {email: 'someone@example.invalid'}};
  // The fake numbers a user by its place in the list: akadmin 1, plane 2, the two test accounts 3 and 4.
  const LIMITED = {...held, 'limited-user-ids': '[3, 4]'};
  const outcome = async (mutate, options = {accounts}, from = held) => {
    const f = await fixture({mutate, ...options});
    try {
      const before = state(f);
      const check = await f.run(from, '--check');
      const r = await f.run(from);
      // The engine reads the entry again after the apply and runs the check on it, and a check that no apply can satisfy
      // fails the row: so the check, the apply, the check, the apply and the check run again here.
      const after = await f.run(r.entry, '--check'), again = await f.run(r.entry), last = await f.run(again.entry, '--check');
      return {check, r, after, again, last, limits: Object.fromEntries(f.limits), changed: state(f) !== before, admin: f.users.has(BOOTSTRAP)};
    } finally {await f.clean();}
  };
  const shipped = await outcome();
  // A limit is no field of any user the API lists, so the check reads the accounts the held entry names as limited.
  assert.deepEqual(shipped.check.entry, {satisfied: false});
  assert.deepEqual([shipped.r.code, shipped.r.entry, shipped.admin], [0, LIMITED, false], shipped.r.stderr);
  assert.deepEqual(shipped.limits, {'plane-sign-in': LIMITS, 'plane-sign-in-uninvited': LIMITS});
  assert.deepEqual([shipped.after.entry, shipped.again.code, shipped.again.entry, shipped.last.entry], [{satisfied: true}, 0, LIMITED, {satisfied: true}],
    shipped.after.stderr + shipped.again.stderr + shipped.last.stderr);
  // PLANTED DEFECTS: no limit, a limit that still allows repositories, and one that reaches every ordinary account.
  assert.deepEqual((await outcome(swap('        limit(auth, tested)\n', ''))).limits, {});
  assert.deepEqual((await outcome(swap("'max_repo_creation': 0", "'max_repo_creation': -1"))).limits['plane-sign-in'].max_repo_creation, -1);
  assert.ok('someone' in (await outcome(swap("if account['email'] in TEST_EMAILS}", "if not account['admin'] and name != USER}"))).limits);
  // PLANTED DEFECT: the old check, which calls the state kept only where no account of a test address exists, and no apply can
  // leave that state; and an apply that records no account, which leaves the check as unsatisfied.
  const unsatisfiable = await outcome(swap("set(limited) >= {account['id'] for account in tested.values()}", 'not tested'));
  assert.deepEqual([unsatisfiable.r.code, unsatisfiable.after.entry, unsatisfiable.last.entry], [0, {satisfied: false}, {satisfied: false}]);
  const unrecorded = await outcome(swap("json.dumps(sorted(account['id'] for account in tested.values()))", "'[]'"));
  assert.deepEqual([unrecorded.r.code, unrecorded.after.entry], [0, {satisfied: false}]);
  // PLANTED INNOCENT: the entry names both accounts, and also one that is gone: the check is satisfied and nothing is limited again.
  for (const named of ['[3, 4]', '[4, 3, 9]']) {
    const kept = await outcome(undefined, {accounts}, {...held, 'limited-user-ids': named});
    assert.deepEqual(kept.check.entry, {satisfied: true}, named);
  }
  // A record that is no list of ids is no held entry: nothing is called kept on it.
  for (const garbled of ['oops', '{"3": 4}', '[true]', '["3"]']) {
    assert.deepEqual((await outcome(undefined, {}, {...held, 'limited-user-ids': garbled})).check.entry, {satisfied: false}, garbled);
  }
  // An account that signs in after the apply is not in the entry: the check finds it, the apply limits both and names both.
  const later = await outcome(undefined, {accounts}, {...held, 'limited-user-ids': '[3]'});
  assert.deepEqual([later.check.entry, later.r.entry, later.after.entry, later.limits], [{satisfied: false}, LIMITED, {satisfied: true}, shipped.limits]);
  // PLANTED INNOCENT: before the first sign-in no Forgejo account of a test address exists, and none is made.
  const none = await outcome(undefined, {});
  assert.deepEqual([none.check.entry, none.r.code, none.limits], [{satisfied: true}, 0, {}]);

  const administrator = {accounts: {'plane-sign-in': {email: INVITED, admin: true}}};
  const refused = await outcome(undefined, administrator);
  for (const run of [refused.check, refused.r]) {
    assert.equal(run.code, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /a Forgejo account of a Plane test address is a site administrator; Plane sign-in was not changed/);
  }
  assert.deepEqual([refused.limits, refused.changed], [{}, false]);
  // PLANTED DEFECT: a producer that lets an administrator stand as the test account.
  assert.equal((await outcome(swap("any(account['admin'] for account in tested.values())", 'False'), administrator)).r.code, 0);
});

// THE PEOPLE WHO USE PLANE. Plane admits a person it has no user for only where sign-up is on or an
// invitation exists for the address (plane/authentication/adapter/base.py sanitize_email and __check_signup: the address lower case,
// stripped; with ENABLE_SIGNUP "0", a WorkspaceMemberInvite for it). Sign-up stays off, so the producer invites every active site
// administrator of Forgejo as an Admin at each run, and the people the installation's answer names in their role.
const signsIn = (f, email) => {
  const address = email.trim().toLowerCase(), {users, invites} = f.admission();
  return users.some(user => user.email === address) || f.settings.get('ENABLE_SIGNUP') !== '0' || invites.some(invite => invite.email === address);
};
const STRANGER = 'stranger@installation.example.test';
const rolesOf = f => Object.fromEntries(f.admission().invites.map(({email, role}) => [email, role]));

test('the administrators of Forgejo are invited to Plane as Admin at each run, a second run changes nothing, and a stranger is refused', async () => {
  const outcome = async (mutate, options = {}) => {
    const f = await fixture({invited: false, mutate, accounts: {someone: {email: 'someone@installation.example.test'}}, ...options});
    try {
      const before = state(f);
      const check = await f.run(held, '--check');
      assert.ok(onlyReads(f));
      assert.equal(state(f), before, 'a check changed state');
      const first = await f.run(held), settled = state(f), second = await f.run(held), after = await f.run(held, '--check');
      return {check: check.entry, first, second, after: after.entry, again: state(f) === settled, roles: rolesOf(f), invites: f.admission().invites,
        signs: Object.fromEntries([ADMINISTRATOR, INVITED, UNINVITED, STRANGER, 'someone@installation.example.test'].map(email => [email, signsIn(f, email)])),
        output: first.stdout + first.stderr + second.stdout + second.stderr};
    } finally {await f.clean();}
  };
  const shipped = await outcome();
  assert.deepEqual([shipped.check, shipped.first.code, shipped.second.code, shipped.after], [{satisfied: false}, 0, 0, {satisfied: true}], shipped.first.stderr + shipped.second.stderr);
  assert.deepEqual(shipped.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN}, 'the administrator as Admin, the test account as Member, nobody else');
  assert.equal(shipped.again, true, 'a second apply changes nothing');
  assert.deepEqual(shipped.signs, {[ADMINISTRATOR]: true, [INVITED]: true, [UNINVITED]: false, [STRANGER]: false, 'someone@installation.example.test': false});
  for (const {token} of shipped.invites) assert.ok(!shipped.output.includes(token));
  // PLANTED DEFECT: every Forgejo account invited, not the administrators alone; the ordinary account then signs in.
  const everyone = await outcome(swap("if account['admin'] and account['active'] and name != BOOTSTRAP", "if name != BOOTSTRAP"));
  assert.equal(everyone.signs['someone@installation.example.test'], true);
  // PLANTED DEFECT: an administrator invited as a Member, who then lands in the workspace without administration.
  const member = await outcome(swap("wanted[account['email'].lower()] = ROLES['admin']", "wanted[account['email'].lower()] = ROLES['member']"));
  assert.equal(member.roles[ADMINISTRATOR], MEMBER);
  // PLANTED DEFECT: the address kept as Forgejo writes it, where Plane compares it lower case.
  const mixed = await outcome(undefined, {akadmin: {email: 'Administrator@Installation.Example.Test'}});
  assert.deepEqual([mixed.roles[ADMINISTRATOR], mixed.signs[ADMINISTRATOR]], [ADMIN, true]);
  const kept = await outcome(swap("wanted[account['email'].lower()]", "wanted[account['email']]"), {akadmin: {email: 'Administrator@Installation.Example.Test'}});
  assert.equal(kept.signs[ADMINISTRATOR], false);
  // PLANTED INNOCENT: a deactivated administrator and the temporary provisioner are no one's invitation, and two administrators are both invited.
  const inactive = await outcome(undefined, {akadmin: {active: false}, staleBootstrap: true});
  assert.deepEqual(inactive.roles, {[INVITED]: MEMBER});
  const two = await outcome(undefined, {accounts: {second: {email: 'second@installation.example.test', admin: true}}});
  assert.deepEqual(two.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN, 'second@installation.example.test': ADMIN});
});

test('a run without an administrator names that state, invites no person of the installation, and a run with one stays silent', async () => {
  const outcome = async (mutate, options = {}) => {
    const f = await fixture({invited: false, mutate, akadmin: {admin: false}, ...options});
    try {
      const first = await f.run(held), after = await f.run(held, '--check');
      return {first, after: after.entry, roles: rolesOf(f), signs: signsIn(f, ADMINISTRATOR)};
    } finally {await f.clean();}
  };
  const none = await outcome();
  assert.equal(none.first.code, 0, none.first.stderr);
  assert.match(none.first.stderr, /no Forgejo administrator exists yet, so nobody is invited to Plane as Admin; sign in to Forgejo once as an administrator of the identity provider, then redeploy/);
  assert.deepEqual([none.roles, none.after, none.signs], [{[INVITED]: MEMBER}, {satisfied: true}, false], 'the standing test account invitation alone');
  // PLANTED DEFECT: a producer that says nothing.
  assert.doesNotMatch((await outcome(swap('sys.stderr.write(', 'str('))).first.stderr, /no Forgejo administrator/);
  // PLANTED INNOCENT: an administrator is named by the answer alone, so Plane has an Admin, and nothing is said.
  const named = await outcome(undefined, {answers: {plane_further_people: ['owner@installation.example.test admin']}});
  assert.deepEqual([named.first.code, named.first.stderr, named.roles['owner@installation.example.test']], [0, '', ADMIN]);
  const present = await outcome(undefined, {akadmin: {admin: true}});
  assert.deepEqual([present.first.stderr, present.roles[ADMINISTRATOR]], ['', ADMIN]);
});

test('the further people of the answer are invited in their role, written any way round, and a bad entry is refused before anything changes', async () => {
  const people = ['  Member.One@Installation.Example.Test   member ', '', 'guest.one@installation.example.test GUEST', 'second.admin@installation.example.test admin'];
  const outcome = async (answers, options = {}) => {
    const f = await fixture({invited: false, ...options, answers: {plane_further_people: answers}});
    try {
      const before = state(f);
      const check = await f.run(held, '--check'), first = await f.run(held);
      return {check, first, roles: rolesOf(f), changed: state(f) !== before, signs: [STRANGER, 'member.one@installation.example.test'].map(email => signsIn(f, email))};
    } finally {await f.clean();}
  };
  const shipped = await outcome(people);
  assert.deepEqual([shipped.check.entry, shipped.first.code], [{satisfied: false}, 0], shipped.first.stderr);
  assert.deepEqual(shipped.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN, 'member.one@installation.example.test': MEMBER,
    'guest.one@installation.example.test': GUEST, 'second.admin@installation.example.test': ADMIN});
  assert.deepEqual(shipped.signs, [false, true]);
  // PLANTED INNOCENT: an empty answer, as the program's default hands it, invites no one beside the administrator and the test account.
  assert.deepEqual((await outcome([])).roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN});
  const refusal = /^.*a further person of Plane .*; Plane sign-in was not changed$/m;
  for (const entries of [
    ['person@installation.example.test owner'], ['person@installation.example.test'], ['not-an-address member'],
    ['person@installation.example.test member extra'], ['person@installation.example.test member', 'PERSON@installation.example.test guest'],
    [`${ADMINISTRATOR} guest`], [`${INVITED} admin`], [`${UNINVITED} member`],
  ]) {
    const refused = await outcome(entries);
    for (const run of [refused.check, refused.first]) {
      assert.equal(run.code, 1, JSON.stringify(entries));
      assert.equal(run.stdout, '');
      assert.match(run.stderr, refusal);
      assert.ok(!run.stderr.includes('@'), 'a refusal names no address');
    }
    assert.equal(refused.changed, false, JSON.stringify(entries));
  }
  // PLANTED DEFECTS: an address kept as typed, where Plane compares it lower case, and the uninvited test address that can be named.
  assert.equal((await outcome(people, {mutate: swap('address = fields[0].lower()', 'address = fields[0]')})).signs[1], false);
  assert.equal((await outcome([`${UNINVITED} member`], {mutate: swap(' or address == UNINVITED.lower()', '')})).roles[UNINVITED], MEMBER);
});

test('the row fills the producer\'s further people from one optional answer that is empty by default', () => {
  const found = (steps, answers) => {
    const problems = [], binding = steps.find(s => s.template === TEMPLATE)?.values?.['plane-further-people'];
    if (binding?.answer !== 'plane_further_people' || binding?.join !== '\n') problems.push('the row does not fill plane-further-people from plane_further_people, one person to a line');
    const declared = answers.find(a => a.name === 'plane_further_people');
    if (declared?.kind !== 'text_list' || declared?.required !== false || JSON.stringify(declared?.default) !== '[]') problems.push('the answer is not an optional list that is empty by default');
    if (/@/.test(JSON.stringify(steps.find(s => s.template === TEMPLATE)?.values?.['plane-further-people']) + JSON.stringify(declared?.default))) problems.push('an address stands in the program');
    return problems;
  };
  assert.deepEqual(found(program.steps, program.answers), []);
  const changed = (stepChange, answerChange) => {
    const steps = structuredClone(program.steps), answers = structuredClone(program.answers);
    stepChange(steps.find(s => s.template === TEMPLATE)); answerChange(answers.find(a => a.name === 'plane_further_people'));
    return found(steps, answers);
  };
  const keep = () => {};
  for (const [name, problems] of [
    ['another answer', changed(row => { row.values['plane-further-people'].answer = 'time_sources'; }, keep)],
    ['one line', changed(row => { row.values['plane-further-people'].join = ', '; }, keep)],
    ['a required answer', changed(keep, answer => { answer.required = true; })],
    ['a default person', changed(keep, answer => { answer.default = ['person@installation.example.test admin']; })],
    ['a text answer', changed(keep, answer => { answer.kind = 'text'; })],
    ['a literal address', changed(row => { row.values['plane-further-people'] = 'person@installation.example.test admin'; }, keep)],
  ]) assert.notDeepEqual(problems, [], name);
});
