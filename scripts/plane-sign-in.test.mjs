import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {existsSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {BEYOND_IDENTIFIERS, CANARY, MODULE, assertRefused, forgejoCommand, planeExec, planeOutput, privateOutcome, program, rendered, root, unreadableInputs, writeProducer} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/plane-sign-in.sh.tpl';
const PEOPLE = 'ansiwise/templates/plane-further-people.tpl';
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
// The account the identity provider's out-of-box flow makes the administrator is akadmin, and its address is the one Plane's
// administrator is invited by. A Forgejo administrator beside it is not that person.
const FORGEJO_ADMINISTRATOR = 'forgejo.administrator@installation.example.test';
const BOOKS = 'books.fixture.invalid', AUTHENTIK_TOKEN = 'fixture-authentik-api-token';
const INVITED = 'simplidigita.ai+plane-sign-in@gmail.com', UNINVITED = 'simplidigita.ai+plane-sign-in-uninvited@gmail.com';
const LIMITS = {allow_create_organization: false, max_repo_creation: 0};
const PROJECT = '5b0c6a3e-3b1d-4e9a-8a11-0d6f9a7c2e41';
const STAND_IN = fileURLToPath(new URL('plane-orm-stand-in.py', import.meta.url));
const PROBE = ['client_id', 'client_secret', 'code', 'grant_type', 'redirect_uri'];
// The engine fills a slot from an answer (ansiwise-plugins write_file_from_template, KeyBinding.resolveIn): the list
// joined, and a slot whose answer holds nothing is left out, so a line with that optional slot is dropped.
const filled = (values, answers = {}) => Object.fromEntries(Object.entries(values).flatMap(([slot, source]) => {
  if (typeof source === 'string') return [[slot, source]];
  const text = source.join === undefined ? (answers[source.answer] ?? '') : (answers[source.answer] ?? []).join(source.join);
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
  // The deployment's further people reach the producer as a file written before it, which it reads as data; none stands in its source.
  const people = steps.find(s => s.template === PEOPLE);
  if (people?.step !== 'write_file_from_template' || people.elevated !== true || people.file_mode !== 384 || people.on_failure !== 'exit' ||
      !machine.every(c => people.when?.includes(c))) problems.push('no file of the further people');
  if (people?.path !== render?.values?.['plane-further-people-file'] || steps.indexOf(people) > steps.indexOf(render)) problems.push('the producer reads no file written before it');
  if (render?.values?.['plane-further-people'] !== undefined) problems.push('the further people stand in the source of the producer');
  // The administrator is read from the books cluster's Authentik with the one API token file the deployment writes for it.
  const token = steps.find(s => s.step === 'file_from_vault' && s.path === '<stage>/idp/bootstrap' && s.field === 'platform-api-token');
  if (!token?.file_path || render?.values?.['authentik-token-file'] !== token.file_path) problems.push('the producer reads another API token file');
  if (render?.values?.['books-fqdn']?.answer !== 'books_fqdn') problems.push('the producer asks another provider than the books cluster\'s');
  // The reporting row records either administrator state, rather than requiring an administrator to exist.
  const report = steps.find(s => s.step === 'wait_for_command_output' && s.command_arguments?.includes('--administrator'));
  if (report?.command !== 'bash' || JSON.stringify(report.command_arguments) !== JSON.stringify([render?.path, '--administrator'])) problems.push('no row reports the administrator');
  else {
    if (report.on_failure !== 'exit') problems.push('a broken report does not stop the deployment');
    if (report.answer !== 'administrator state reported') problems.push('the report requires an administrator instead of a state');
    if (report.keep_output !== true || report.elevated !== true || report.rests_on_an_earlier_step !== true) problems.push('the report is not kept or not run as root');
    if (!machine.every(c => report.when?.includes(c)) || steps.indexOf(report) < steps.indexOf(row)) problems.push('the report is on another machine or before the producer');
    if (!/administrator of Plane/.test(report.waiting_for ?? '')) problems.push('the report does not name the administrator of Plane');
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
    // The further people: no file written for the producer, a file it does not read, one written after it, and the old splice into its source.
    steps => { steps.splice(steps.findIndex(s => s.template === PEOPLE), 1); },
    steps => { steps.find(s => s.template === PEOPLE).path = '/run/another-file'; },
    steps => { steps.push(...steps.splice(steps.findIndex(s => s.template === PEOPLE), 1)); },
    steps => { render(steps).values['plane-further-people'] = {answer: 'plane_further_people', join: '\n'}; },
    // The administrator: another token file, another provider, and a report that is missing, hides failure, requires an administrator, is not kept, runs before the
    // producer or does not name what it reports.
    steps => { render(steps).values['authentik-token-file'] = '/run/another-token'; },
    steps => { render(steps).values['books-fqdn'] = {answer: 'fqdn'}; },
    steps => { steps.splice(steps.findIndex(s => s.command_arguments?.includes('--administrator')), 1); },
    steps => { steps.find(s => s.command_arguments?.includes('--administrator')).on_failure = 'continue'; },
    steps => { steps.find(s => s.command_arguments?.includes('--administrator')).answer = 'administrator known'; },
    steps => { delete steps.find(s => s.command_arguments?.includes('--administrator')).keep_output; },
    steps => { steps.unshift(...steps.splice(steps.findIndex(s => s.command_arguments?.includes('--administrator')), 1)); },
    steps => { steps.find(s => s.command_arguments?.includes('--administrator')).waiting_for = 'a state'; },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
});

test('the producer renders under the engine\'s slot rule with exactly its row\'s values', () => {
  const template = readFileSync(new URL(TEMPLATE, root), 'utf8');
  const {values} = program.steps.find(s => s.template === TEMPLATE);
  const answers = {books_fqdn: 'master.installation.example.test'};
  const text = rendered(template, filled(values, answers));
  assert.ok(!text.match(/<[a-z][a-z0-9-]*\??>/));
  // The provider is the one of the books cluster, at the address the books cluster's rows use for it, and no answer of the deployment stands in source.
  assert.ok(text.includes("'https://idp.master.installation.example.test'"));
  // PLANTED: an angle-bracketed word in a comment is a slot no row fills, and the engine refuses it.
  assert.throws(() => rendered(template.replace('# The installer', '# GET /users/<user>\n# The installer'), filled(values, answers)), /unfilled <user>/);
  assert.throws(() => rendered(template, {...filled(values, answers), 'forgejo-planted': 'x'}), /unplaced forgejo-planted/);
  // The people file is the whole template of its row: one line per person, and none where the answer is empty.
  const people = program.steps.find(s => s.template === PEOPLE);
  const peopleText = readFileSync(new URL(PEOPLE, root), 'utf8');
  assert.equal(rendered(peopleText, filled(people.values, {plane_further_people: ['one@installation.example.test member', 'two@installation.example.test admin']})),
    'one@installation.example.test member\ntwo@installation.example.test admin\n');
  assert.equal(rendered(peopleText, filled(people.values, {plane_further_people: []})), '');
  assert.throws(() => rendered(peopleText, {...filled(people.values), 'plane-planted': 'x'}), /unplaced plane-planted/);
});

// A stand-in for the pinned Forgejo 15.0.10: its user CLI, the OAuth2 application API of a user
// (routers/api/v1/user/app.go: create returns the secret once, a list hides it, a PATCH regenerates
// it), the header Sudo for an administrator only (api.go sudo), and the token endpoint, which judges
// an authorization code in the order of routers/web/auth/oauth.go handleAuthorizationCode. Beside it
// a stand-in for Plane v1.4.2's InstanceConfiguration rows, which the snippets read and write.
async function fixture(options = {}) {
  const render = program.steps.find(s => s.template === TEMPLATE);
  const directory = await mkdtemp(join(tmpdir(), 'plane-sign-in-'));
  const commands = [], inputs = [], requests = [], snippets = [], authentikRequests = [];
  // Forgejo holds an administrator of its own beside Authentik's, unless an installation's Forgejo has seen no sign-in yet.
  const users = new Map(options.forgejoAdministrator === false ? [] :
    [['akadmin', {email: FORGEJO_ADMINISTRATOR, admin: true, restricted: false, active: true}]]);
  // Authentik's akadmin, as the API lists it: the administrator who completed the out-of-box flow, none, or one the flow left unset.
  const account = overrides => overrides === null ? null :
    {pk: 1, username: 'akadmin', name: 'authentik Default Admin', is_active: true, email: ADMINISTRATOR, ...overrides};
  let authentikAccount = account(options.authentik);
  const setAuthentik = overrides => { authentikAccount = account(overrides); };
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
  const listed = a => ({id: 'listedId' in options ? options.listedId : a.id, name: a.name, client_id: a.client_id, client_secret: '', confidential_client: a.confidential, redirect_uris: a.redirect_uris, created: '2026-10-17T00:00:00Z'});
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
      if (options.probe) return send(options.probeStatus ?? 400, options.probe(form, apps.find(a => a.client_id === form.get('client_id'))));
      if (!app) return refused('invalid_client', `cannot load client with client id: '${form.get('client_id')}'`);
      if (app.confidential && form.get('client_secret') !== app.secret) return refused('unauthorized_client', 'invalid client secret');
      if (!app.redirect_uris.includes(form.get('redirect_uri'))) return refused('unauthorized_client', 'unexpected redirect URI');
      return refused('unauthorized_client', 'client is not authorized');
    }
    if (path === '/api/v3/core/users/' && req.method === 'GET') {
      authentikRequests.push({query: url.search, authorization: req.headers.authorization});
      assert.deepEqual([...url.searchParams.keys()], ['username']);
      if (req.headers.authorization !== 'Bearer ' + AUTHENTIK_TOKEN) return send(403, {detail: 'Token invalid/expired'});
      if (options.authentikStatus) return send(options.authentikStatus, options.authentikBody ?? {});
      const listed = authentikAccount && url.searchParams.get('username') === 'akadmin' ? [authentikAccount] : [];
      return send(200, {pagination: {count: listed.length}, results: listed});
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
  // The two files the deployment writes for the producer before it runs: its further people, rendered from the row that writes them, and
  // the API token of Authentik.
  const peopleFile = join(directory, 'further-people'), tokenFile = join(directory, 'idp-api-token.txt');
  let producer, kubectl;
  try {
    const people = program.steps.find(s => s.template === PEOPLE);
    if (options.peopleFile !== false) await writeFile(peopleFile, rendered(readFileSync(new URL(PEOPLE, root), 'utf8'), filled(people.values, options.answers)));
    if (options.authentikToken !== false) await writeFile(tokenFile, AUTHENTIK_TOKEN + '\n');
    const values = {...filled(render.values, {books_fqdn: BOOKS, ...options.answers}), 'plane-further-people-file': peopleFile, 'authentik-token-file': tokenFile};
    ({producer, kubectl} = await writeProducer(directory, TEMPLATE, values, {mutate: options.mutate, port}));
    // The one change to what the engine renders: the books cluster's Authentik is reached over plain HTTP on the fake's port, or on
    // port 1, where nothing listens.
    const address = `'https://idp.${BOOKS}'`, text = await readFile(producer, 'utf8');
    assert.ok(text.includes(address), 'the producer asks the Authentik of the books cluster');
    await writeFile(producer, text.replace(address, `'http://127.0.0.1:${options.authentikUnreachable ? 1 : port}'`));
  } catch (error) {await clean(); throw error;}
  const stderrs = [];
  const secrets = () => [SECRET, PASSWORD, AUTHENTIK_TOKEN, ...apps.map(a => a.secret)];
  const spawned = (args, stdin) => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, ...args], {cwd: directory});
    let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      stderrs.push(stderr);
      try {
        const result = {code, stdout, stderr, entry: code === 0 && args[0] !== '--administrator' ? JSON.parse(stdout) : null};
        resolve(args[0] === '--administrator' ? result : privateOutcome(result, secrets()));
      } catch (error) {reject(error);}
    });
    child.stdin.end(stdin);
  });
  const run = (entry, mode = '--apply', raw = undefined) => spawned([mode, '--', kubectl], raw ?? JSON.stringify({entry, inputs: {}}));
  // What the row after the producer runs: bash the producer --administrator, which reads only.
  const report = () => spawned(['--administrator'], '');
  // Forgejo accepts this client id and secret: a confidential application of user plane with our redirect URI.
  const accepts = (id, secret) => apps.some(a => a.owner === USER && a.client_id === id && a.confidential && a.secret === secret &&
    JSON.stringify(a.redirect_uris) === JSON.stringify([REDIRECT]));
  // A client secret stands only in the stdin of the write snippet and in the producer's stdout: in no
  // file, no argument (the snippet's arguments decoded included), no other stdin and no stderr.
  const privateSecrets = async () => {
    for (const file of await readdir(directory)) {
      if (join(directory, file) === tokenFile) continue;
      const text = await readFile(join(directory, file), 'utf8');
      for (const secret of secrets()) assert.ok(!text.includes(secret), file + ' holds a secret');
    }
    for (const [i, argv] of commands.entries()) {
      const carried = argv.join(' ') + JSON.stringify(planeExec(argv)?.args ?? null);
      for (const secret of secrets()) {
        assert.ok(!carried.includes(secret), 'an argument carries a secret');
        if (planeExec(argv)?.name !== WRITE) assert.ok(!inputs[i].includes(secret), 'a stdin other than the write snippet\'s carries a secret');
      }
    }
    for (const stderr of stderrs) for (const secret of secrets()) assert.ok(!stderr.includes(secret), 'stderr carries a secret');
  };
  return {run, report, setAuthentik, clean, accepts, privateSecrets, directory, users, apps, settings, limits, admission, commands, inputs, requests, authentikRequests, snippets,
    get changes() {return changes;}};
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
      assert.equal(r.code, 1, JSON.stringify(options)); assertRefused(r, refusal);
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
  assertRefused(unaccepted.first, /Plane did not keep the invitation of the test account or of a person of the installation/);
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
    assertRefused(r, /Plane has no workspace simplidigita; create it in Plane, then redeploy/);
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
    assertRefused(run, /a Forgejo account of a Plane test address is a site administrator; Plane sign-in was not changed/);
  }
  assert.deepEqual([refused.limits, refused.changed], [{}, false]);
  // PLANTED DEFECT: a producer that lets an administrator stand as the test account.
  assert.equal((await outcome(swap("any(account['admin'] for account in tested.values())", 'False'), administrator)).r.code, 0);
});

// THE PEOPLE WHO USE PLANE. Plane admits a person it has no user for only where sign-up is on or an
// invitation exists for the address (plane/authentication/adapter/base.py sanitize_email and __check_signup: the address lower case,
// stripped; with ENABLE_SIGNUP "0", a WorkspaceMemberInvite for it). Sign-up stays off, so the producer invites the administrator of the
// identity provider as an Admin at each run, and the people the installation's answer names in their role.
const signsIn = (f, email) => {
  const address = email.trim().toLowerCase(), {users, invites} = f.admission();
  return users.some(user => user.email === address) || f.settings.get('ENABLE_SIGNUP') !== '0' || invites.some(invite => invite.email === address);
};
const STRANGER = 'stranger@installation.example.test';
const rolesOf = f => Object.fromEntries(f.admission().invites.map(({email, role}) => [email, role]));
const UNKNOWN = 'Plane has no administrator to invite yet: ';

test('the administrator of Plane is the address Authentik holds for akadmin, invited as Admin at each run with no Forgejo sign-in first, and no one else is', async () => {
  const outcome = async (mutate, options = {}) => {
    const f = await fixture({invited: false, mutate, forgejoAdministrator: false, ...options});
    try {
      const before = state(f);
      const check = await f.run(held, '--check');
      assert.ok(onlyReads(f));
      assert.equal(state(f), before, 'a check changed state');
      const first = await f.run(held), settled = state(f), second = await f.run(held), after = await f.run(held, '--check');
      await f.privateSecrets();
      return {check: check.entry, first, second, after: after.entry, again: state(f) === settled, roles: rolesOf(f), invites: f.admission().invites, asked: f.authentikRequests,
        signs: Object.fromEntries([ADMINISTRATOR, FORGEJO_ADMINISTRATOR, INVITED, UNINVITED, STRANGER].map(email => [email, signsIn(f, email)])),
        output: first.stdout + first.stderr + second.stdout + second.stderr};
    } finally {await f.clean();}
  };
  const shipped = await outcome();
  assert.deepEqual([shipped.check, shipped.first.code, shipped.second.code, shipped.after], [{satisfied: false}, 0, 0, {satisfied: true}], shipped.first.stderr + shipped.second.stderr);
  assert.deepEqual(shipped.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN}, 'the address of akadmin as Admin, the test account as Member, nobody else');
  assert.equal(shipped.again, true, 'a second apply changes nothing');
  assert.deepEqual(shipped.signs, {[ADMINISTRATOR]: true, [FORGEJO_ADMINISTRATOR]: false, [INVITED]: true, [UNINVITED]: false, [STRANGER]: false});
  assert.deepEqual(shipped.asked.map(({query, authorization}) => [query, authorization]), Array(4).fill(['?username=akadmin', 'Bearer ' + AUTHENTIK_TOKEN]), 'each run asks for akadmin alone, with the token');
  for (const {token} of shipped.invites) assert.ok(!shipped.output.includes(token));
  // PLANTED INNOCENT: a Forgejo administrator who is not akadmin, and the Forgejo account named akadmin with its own address, are no one's invitation.
  const beside = await outcome(undefined, {forgejoAdministrator: true, accounts: {second: {email: 'second@installation.example.test', admin: true}}});
  assert.deepEqual(beside.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN});
  assert.equal(beside.signs[FORGEJO_ADMINISTRATOR], false);
  // PLANTED DEFECT: the administrator invited as a Member, who then lands in the workspace without administration.
  const member = await outcome(swap("wanted[administrator] = ROLES['admin']", "wanted[administrator] = ROLES['member']"));
  assert.equal(member.roles[ADMINISTRATOR], MEMBER);
  // PLANTED DEFECT: the address kept as Authentik writes it, where Plane compares it lower case.
  const mixed = await outcome(undefined, {authentik: {email: 'Administrator@Installation.Example.Test'}});
  assert.deepEqual([mixed.roles[ADMINISTRATOR], mixed.signs[ADMINISTRATOR]], [ADMIN, true]);
  const kept = await outcome(swap('return email.lower(), None', 'return email, None'), {authentik: {email: 'Administrator@Installation.Example.Test'}});
  assert.equal(kept.signs[ADMINISTRATOR], false);
  // PLANTED DEFECT: no token sent, which Authentik refuses.
  const bare = await outcome(swap("'Bearer ' + token", 'token'));
  assert.deepEqual([bare.roles, bare.first.code], [{[INVITED]: MEMBER}, 0]);
  // PLANTED DEFECT: a deactivated akadmin, and the address Authentik gives it before its out-of-box flow, invited as Admin.
  const inactive = {authentik: {is_active: false}}, unset = {authentik: {email: 'root@localhost'}};
  for (const options of [inactive, unset]) assert.deepEqual((await outcome(undefined, options)).roles, {[INVITED]: MEMBER});
  assert.equal((await outcome(swap('if active is not True:', 'if False:'), inactive)).roles[ADMINISTRATOR], ADMIN);
  assert.equal((await outcome(swap('not isinstance(email, str) or not is_address(email)', 'not isinstance(email, str)'), unset)).roles['root@localhost'], ADMIN);
  // PLANTED DEFECT: the account of the sign-in proof made an administrator through akadmin's address.
  for (const email of [INVITED, UNINVITED]) {
    const clash = await outcome(undefined, {authentik: {email}});
    assert.deepEqual([clash.first.code, clash.first.stdout, clash.roles], [1, '', {}]);
    assertRefused(clash.first, 'the administrator of the identity provider has the address of a Plane test account; Plane sign-in was not changed');
    assert.ok(!clash.first.stderr.includes('@'), 'a refusal names no address');
  }
  const admin = await outcome(swap('        if administrator in [address.lower() for address in TEST_EMAILS]:', '        if False:'), {authentik: {email: INVITED}});
  assert.equal(admin.roles[INVITED], ADMIN);
});

test('the real engine records the pending administrator as declared and exits zero, and records the known state', async () => {
  const row = program.steps.find(s => s.command_arguments?.includes('--administrator'));
  const report = async (options = {}) => {
    const f = await fixture(options);
    try {return await f.report();} finally {await f.clean();}
  };
  const pending = {authentik: {email: 'root@localhost'}};
  const response = await report(pending), known = await report();
  const reason = UNKNOWN + 'akadmin has no address yet';
  const oldWait = {...row, answer: 'administrator known', on_failure: 'continue'};
  const silent = await report({...pending, mutate: swap("'Plane has no administrator to invite yet: ' + why", "''")});
  const falseKnown = await report({...pending, mutate: swap('    if address is None:', '    if False:')});
  const reports = [
    {row, response},
    {row, response: known},
    {row: oldWait, response},
    {row: {...row, keep_output: false}, response},
    {row, response: silent},
    {row, response: falseKnown},
    {row, response: {...response, code: 1}},
    {row, response: {...response, stdout: '', stderr: ''}},
  ];
  const directory = await mkdtemp(join(tmpdir(), 'plane-administrator-engine-'));
  let records;
  try {
    const cli = process.env.ANSIWISE_CLI_CHECKOUT;
    assert.ok(cli, 'set ANSIWISE_CLI_CHECKOUT; scripts/test.sh sets it to the pinned ansiwise-cli tree');
    const packages = join(cli, '.dart_tool/package_config.json');
    assert.ok(existsSync(packages), 'the CLI binding suite needs its resolved Dart packages; scripts/test.sh resolves them');
    records = JSON.parse(execFileSync('dart', ['--packages=' + packages, new URL('scripts/plane-administrator-record.dart', root).pathname], {
      cwd: directory, encoding: 'utf8', input: JSON.stringify({command: 'bash ' + row.command_arguments.join(' '), reports}), timeout: 60_000,
    }));
  } finally {await rm(directory, {recursive: true, force: true});}
  const recorded = (record, state) => {
    assert.equal(record.exit, 0, 'the Manager rejects every nonzero deployment exit');
    assert.equal(record.clean, true);
    assert.deepEqual(record.issues, []);
    assert.deepEqual([record.standing, record.fully_proven], ['declared', false]);
    assert.deepEqual([record.closed, record.next_reached], [true, true]);
    assert.ok(record.output.includes(state), 'the run record must name the actual administrator state');
  };
  assert.equal(records.length, reports.length);
  recorded(records[0], reason);
  // PLANTED INNOCENT: the administrator is known; the same row records that state and still exits zero.
  recorded(records[1], 'administrator known');
  assert.ok(!records[0].output.includes('administrator known'), 'pending must never claim known');
  // PLANTED DEFECTS: the old failed wait, discarded output, a silent or false-known report, a failed
  // reporting command and a command that answers nothing. Each fails the same record assertion.
  for (const record of records.slice(2)) assert.throws(() => recorded(record, reason));
  assert.deepEqual([records[2].exit, records[2].clean, records[2].next_reached, records[2].issues.length], [2, false, true, 1]);
});

test('an administrator Authentik does not have yet is reported, invites the test account alone, and is invited by the next run', async () => {
  const REPORT = program.steps.find(s => s.step === 'wait_for_command_output' && s.command_arguments?.includes('--administrator'));
  const outcome = async (mutate, options = {}) => {
    const f = await fixture({invited: false, mutate, forgejoAdministrator: false, ...options});
    try {
      const check = await f.run(held, '--check'), first = await f.run(held), after = await f.run(held, '--check'), report = await f.report();
      await f.privateSecrets();
      return {check: check.entry, first, after: after.entry, roles: rolesOf(f), report};
    } finally {await f.clean();}
  };
  const pending = [
    ['no akadmin', {authentik: null}, 'the identity provider holds no readable akadmin'],
    ['an answer without a list', {authentikStatus: 200, authentikBody: {}}, 'the identity provider holds no readable akadmin'],
    ['an unreadable answer', {authentikStatus: 200, authentikBody: 'not json'}, 'the identity provider holds no readable akadmin'],
    ['the address Authentik gives akadmin first', {authentik: {email: 'root@localhost'}}, 'akadmin has no address yet'],
    ['an empty address', {authentik: {email: ''}}, 'akadmin has no address yet'],
    ['an inactive akadmin', {authentik: {is_active: false}}, 'akadmin is not active'],
    ['a token Authentik does not accept yet', {authentikStatus: 403}, 'the identity provider answered HTTP 403'],
    ['an error of Authentik', {authentikStatus: 503}, 'the identity provider answered HTTP 503'],
    ['no token file', {authentikToken: false}, 'the API token of the identity provider is not in its file yet'],
    ['a provider that is not reachable', {authentikUnreachable: true}, 'the identity provider could not be reached'],
  ];
  for (const [name, options, why] of pending) {
    const state = await outcome(undefined, options);
    // The producer goes on with the test account alone, says nothing on its streams, and its check is satisfied after it.
    assert.deepEqual([state.check, state.first.code, state.first.stderr, state.after, state.roles], [{satisfied: false}, 0, '', {satisfied: true}, {[INVITED]: MEMBER}], name);
    // Reporting a pending state succeeds without claiming an administrator exists; no address or token is output.
    assert.deepEqual([state.report.code, state.report.stdout, state.report.stderr], [0, UNKNOWN + why + '\n' + REPORT.answer + '\n', ''], name);
    assert.ok(!/@|fixture-authentik/.test(state.report.stdout), name);
  }
  // PLANTED INNOCENT: akadmin has an address, so the report names the known state without the address, and the administrator is invited.
  const known = await outcome();
  assert.deepEqual([known.report.code, known.report.stdout, known.report.stderr, known.roles], [0, 'administrator known\n' + REPORT.answer + '\n', '', {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN}]);
  const unsaid = pending[3][1];
  // PLANTED DEFECT: a producer that fails the deployment where the provider is not ready.
  assert.equal((await outcome(swap("return None, 'akadmin has no address yet'", "refuse('akadmin has no address yet')"), unsaid)).first.code, 1);
  // The next run invites: the same installation, once akadmin has its address.
  const f = await fixture({invited: false, forgejoAdministrator: false, authentik: {email: 'root@localhost'}});
  try {
    await f.run(held);
    assert.deepEqual([rolesOf(f), (await f.report()).stdout], [{[INVITED]: MEMBER}, UNKNOWN + 'akadmin has no address yet\n' + REPORT.answer + '\n']);
    f.setAuthentik({email: ADMINISTRATOR});
    assert.deepEqual([(await f.run(held, '--check')).entry, (await f.run(held)).code, rolesOf(f), (await f.run(held, '--check')).entry, (await f.report()).stdout],
      [{satisfied: false}, 0, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN}, {satisfied: true}, 'administrator known\n' + REPORT.answer + '\n']);
  } finally {await f.clean();}
});

test('a further person is data: an entry that closes a string and adds a statement is refused before anything happens, and a well-formed entry is invited in its role', async () => {
  const outcome = async (answers, options = {}) => {
    const f = await fixture({invited: false, ...options, answers: {plane_further_people: answers}});
    try {
      const before = state(f);
      const check = await f.run(held, '--check'), first = await f.run(held);
      return {check, first, roles: rolesOf(f), changed: state(f) !== before, contacted: f.commands.length + f.requests.length + f.authentikRequests.length,
        injected: existsSync(join(f.directory, 'injected')), signs: [STRANGER, 'member.one@installation.example.test', "o'brien@installation.example.test"].map(email => signsIn(f, email))};
    } finally {await f.clean();}
  };
  const people = ['  Member.One@Installation.Example.Test   member ', '', 'guest.one@installation.example.test GUEST', 'second.admin@installation.example.test admin', "o'brien@installation.example.test member"];
  const shipped = await outcome(people);
  assert.deepEqual([shipped.check.entry, shipped.first.code, shipped.injected], [{satisfied: false}, 0, false], shipped.first.stderr);
  assert.deepEqual(shipped.roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN, 'member.one@installation.example.test': MEMBER, 'guest.one@installation.example.test': GUEST,
    'second.admin@installation.example.test': ADMIN, "o'brien@installation.example.test": MEMBER});
  assert.deepEqual(shipped.signs, [false, true, true]);
  // PLANTED INNOCENT: an empty answer, as the program's default hands it, invites no one beside the administrator and the test account.
  assert.deepEqual((await outcome([])).roles, {[INVITED]: MEMBER, [ADMINISTRATOR]: ADMIN});
  // PLANTED DEFECTS: an entry that closes the string the producer once held its people in and then runs a statement, on one line and over several.
  const statement = "open('injected', 'w').write('x')";
  const injections = [
    [`person@installation.example.test member''';${statement};'''`],
    [`person@installation.example.test member\n'''\n${statement}\nrest = r'''`],
    [`person@installation.example.test member"""; ${statement}; """`],
    [`person@installation.example.test member\\''';${statement};'''`],
  ];
  const refusal = /^.*further (person|people) of Plane .*; Plane sign-in was not changed$/m;
  // An entry that is no address and role is refused before anything is contacted; one that clashes with the producer's own people only once
  // the administrator is known, and still before anything is changed.
  const refused = (result, entries, early = true) => {
    for (const run of [result.check, result.first]) {
      assert.equal(run.code, 1, JSON.stringify(entries));
      assertRefused(run, refusal);
      assert.ok(!run.stderr.includes('@'), 'a refusal names no address');
    }
    assert.deepEqual([result.changed, early ? result.contacted : 0, result.injected], [false, 0, false], JSON.stringify(entries));
  };
  for (const entries of injections) refused(await outcome(entries), entries);
  // PLANTED DEFECTS: a role outside the closed set, no role, a name that is no address, an extra field, a person named twice, and the addresses
  // that belong to the producer's own people.
  for (const entries of [
    ['person@installation.example.test owner'], ['person@installation.example.test'], ['not-an-address member'], ['person@localhost member'],
    ['semi;colon@installation.example.test member'], ['"quoted"@installation.example.test member'], ['paren(thesis)@installation.example.test member'],
    ['person@installation..example.test member'], ['person@installation.example.test member extra'],
    ['person@installation.example.test member', 'PERSON@installation.example.test guest'],
  ]) refused(await outcome(entries), entries);
  for (const entries of [[`${ADMINISTRATOR} guest`], [`${INVITED} admin`], [`${UNINVITED} member`]]) refused(await outcome(entries), entries, false);
  // PLANTED DEFECT: a file the deployment did not write is no empty list of people.
  refused(await outcome([], {peopleFile: false}), 'no file');
  // PLANTED DEFECTS: the validation weakened, run late, or an address kept as typed.
  const unchecked = await outcome(['semi;colon@installation.example.test member'], {mutate: swap(' and LOCAL.fullmatch(local) is not None', '')});
  assert.equal(unchecked.roles['semi;colon@installation.example.test'], MEMBER);
  const late = text => swap('    named = further_people()\n', '')(swap('    access.ready_pod()\n', '    access.ready_pod()\n    named = further_people()\n')(text));
  assert.ok((await outcome(injections[0], {mutate: late})).contacted > 0);
  assert.equal((await outcome(people, {mutate: swap('address = fields[0].lower()', 'address = fields[0]')})).signs[1], false);
  assert.equal((await outcome([`${UNINVITED} member`], {mutate: swap(' or address == UNINVITED.lower()', '')})).roles[UNINVITED], MEMBER);
});

test('the rows hand the producer its people as a file written from one optional answer that is empty by default, and no address stands in the program', () => {
  const found = (steps, answers) => {
    const problems = [], row = steps.find(s => s.template === PEOPLE), binding = row?.values?.['plane-further-people'];
    if (binding?.answer !== 'plane_further_people' || binding?.join !== '\n') problems.push('the row does not fill plane-further-people from plane_further_people, one person to a line');
    const declared = answers.find(a => a.name === 'plane_further_people');
    if (declared?.kind !== 'text_list' || declared?.required !== false || JSON.stringify(declared?.default) !== '[]') problems.push('the answer is not an optional list that is empty by default');
    if (/@/.test(JSON.stringify(row?.values?.['plane-further-people']) + JSON.stringify(declared?.default))) problems.push('an address stands in the program');
    return problems;
  };
  assert.deepEqual(found(program.steps, program.answers), []);
  const changed = (stepChange, answerChange) => {
    const steps = structuredClone(program.steps), answers = structuredClone(program.answers);
    stepChange(steps.find(s => s.template === PEOPLE)); answerChange(answers.find(a => a.name === 'plane_further_people'));
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

test('a producer handed input it cannot read refuses by name and repeats none of it', async () => {
  const f = await fixture();
  try {
    for (const [reason, raw] of unreadableInputs(CANARY)) assertRefused(await f.run(null, '--apply', raw), reason, [CANARY]);
  } finally {await f.clean();}
});

test('an answer of the client probe that is not the one expected is refused with fixed text, and its error is never echoed', async () => {
  // PLANTED DEFECTS: the first probe answers an error nobody knows; the second probe, after the first said "not authorized", does.
  const unknown = {error: 'unexpected_' + CANARY, error_description: CANARY};
  const probes = [
    [() => unknown, /^Forgejo answered the client probe unexpectedly; Plane sign-in was not changed$/],
    [(form, app) => form.get('client_secret') === SECRET ? {error: 'unauthorized_client', error_description: 'client is not authorized'} : unknown,
      /^Forgejo answered the second client probe unexpectedly; Plane sign-in was not changed$/],
  ];
  for (const [probe, refusal] of probes) for (const mode of ['--check', '--apply']) {
    const f = await fixture({probe});
    try {
      assertRefused(await f.run(held, mode), refusal, [CANARY]);
    } finally {await f.clean();}
  }
  // PLANTED INNOCENT: an answer that is no error of Forgejo's, by its status or by its body, is named by its status as the integer it is.
  for (const [status, probe] of [[503, () => unknown], [400, () => ({})]]) for (const mode of ['--check', '--apply']) {
    const f = await fixture({probe, probeStatus: status});
    try {
      assertRefused(await f.run(held, mode), `Forgejo answered the client probe with HTTP ${status}; body withheld`, [CANARY]);
    } finally {await f.clean();}
  }
});

test('an OAuth application listed under an id that is no Forgejo id is refused before its path is built', async () => {
  for (const id of [CANARY, {id: CANARY}, true, 0, -1, 2 ** 70, ...BEYOND_IDENTIFIERS, null]) {
    const f = await fixture({listedId: id});
    try {
      assertRefused(await f.run(null), 'Forgejo listed the OAuth2 application plane without its id', [CANARY]);
      assert.ok(!f.requests.some(q => q.method === 'PATCH'), 'no application path was built: ' + JSON.stringify(id));
    } finally {await f.clean();}
  }
});
