import assert from 'node:assert/strict';
import {spawn, execFileSync} from 'node:child_process';
import {createServer} from 'node:http';
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
const program = JSON.parse(execFileSync('yq', ['-o=json', '.', new URL('ansiwise/programs/deploy-platform-services.yaml', root).pathname], {encoding: 'utf8'}));

function wiring(steps) {
  const writers = steps.filter(s => s.path === '<stage>/app/forgejo-build');
  if (writers.length !== 1 || writers[0].step !== 'vault_kv_entry_from_command') return ['not one complete-entry writer'];
  const row = writers[0], problems = [];
  if (JSON.stringify(row.fields) !== JSON.stringify(Object.keys(entry))) problems.push('not the three credential fields');
  if (JSON.stringify(row.fields_from_answers) !== JSON.stringify(['plane-api-token=plane_api_token'])) problems.push('missing secret input');
  if (!['books_here_in_answers', 'build_plane_here_in_answers'].every(c => row.when?.includes(c))) problems.push('wrong machine');
  if (row.on_failure !== 'exit') problems.push('failure continued');
  const render = steps.find(s => s.path === row.producer);
  if (render?.step !== 'write_file_from_template' || render.template !== 'ansiwise/templates/forgejo-build-credentials.sh.tpl') problems.push('no application producer');
  if (steps.indexOf(row) <= steps.findIndex(s => s.manifest === 'clusters/argocd/root-app.yaml')) problems.push('before Forgejo can start');
  return problems;
}

test('one installer writer follows the handoff and reads the optional secret answer', () => {
  assert.deepEqual(wiring(program.steps), []);
  const answer = program.answers.find(a => a.name === 'plane_api_token');
  assert.equal(answer?.secret, true);
  assert.equal(answer?.required, false);
  assert.equal(answer?.default, undefined);
  for (const defect of [
    steps => steps.push(structuredClone(steps.find(s => s.path === '<stage>/app/forgejo-build'))),
    steps => { steps.find(s => s.path === '<stage>/app/forgejo-build').fields.push('plane-project'); },
    steps => { steps.find(s => s.path === '<stage>/app/forgejo-build').on_failure = 'continue'; },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), []);
  }
  assert.deepEqual(wiring([...program.steps]), []);
});

async function fixture(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-credentials-'));
  const commands = [], requests = [], users = new Map(), tokens = new Map();
  const user = {login: USER, is_admin: false, restricted: true, active: true};
  if (options.exists !== false) users.set(USER, {email: USER + '@hostyour.invalid', admin: false});
  if (options.staleBootstrap) users.set(BOOTSTRAP, {email: BOOTSTRAP + '@hostyour.invalid', admin: true});
  if (options.staleToken) tokens.set(USER, {name: USER, id: 7, value: 'lost-fixture-secret'});
  let granted = options.granted ?? true, generation = 0;
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const path = new URL(req.url, 'http://fixture.invalid').pathname;
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
        case 'list': return send(200, 'ID Username Email IsActive IsAdmin 2FA\n' + [...users].map(([n, v], i) => `${i + 1} ${n} ${v.email} true ${v.admin} false`).join('\n') + '\n');
        case 'create':
          assert.ok(!args.includes('--password'), 'no password in arguments');
          assert.ok(args.includes('--random-password'));
          if (users.has(name)) return send(500, 'already exists');
          users.set(name, {email: args[args.indexOf('--email') + 1], admin: args.includes('--admin')});
          if (name === USER) assert.ok(args.includes('--restricted'));
          return send(200, `generated random password is '${PASSWORD}'\nNew user created\n`);
        case 'delete': users.delete(name); return send(200);
        case 'generate-access-token':
          assert.equal(name, USER);
          assert.equal(args[args.indexOf('--token-name') + 1], USER);
          assert.equal(args[args.indexOf('--scopes') + 1], 'write:repository');
          assert.ok(args.includes('--raw'));
          if (tokens.has(USER)) return send(500, 'same name exists');
          generation++; tokens.set(USER, {name: USER, id: 8, value: TOKEN});
          return send(200, TOKEN + '\n');
        default: return send(500, 'unexpected command');
      }
    }
    requests.push({method: req.method, path, body: text});
    if (options.apiFailure) return send(503, TOKEN);
    const basic = req.headers.authorization === 'Basic ' + Buffer.from(BOOTSTRAP + ':' + PASSWORD).toString('base64');
    const token = req.headers.authorization?.replace(/^token /, '');
    const valid = token === TOKEN && (options.valid !== false || generation > 0);
    if (!basic && !valid) return send(401, TOKEN);
    if (path === '/api/v1/users/' + USER + '/tokens') {
      if (!basic) return send(403);
      return send(200, [...tokens.values()].map(({value, ...t}) => t));
    }
    if (path === '/api/v1/users/' + USER + '/tokens/' + USER && req.method === 'DELETE') {
      if (!basic) return send(403);
      tokens.delete(USER); return send(204);
    }
    if (options.pause && basic) await new Promise(resolve => setTimeout(resolve, 200));
    const base = '/api/v1/repos/' + REPO + '/collaborators/';
    if (path === base + USER && req.method === 'PUT') {
      if (!basic) return send(403);
      assert.deepEqual(JSON.parse(text), {permission: 'write'});
      granted = true; return send(204);
    }
    if (path === base + USER + '/permission') {
      if (!granted) return send(404);
      return send(200, {user: {...user, ...(options.badUser ?? {})}, permission: 'write'});
    }
    if (path === base + 'akadmin/permission') return send(basic || options.ownerToken ? 200 : 403, {});
    if (path === '/api/v1/user/repos') return send(200, [{full_name: REPO, permissions: {push: true, admin: options.repoAdmin ?? false}}, ...(options.unrelated ? [{full_name: 'akadmin/unrelated', permissions: {push: true}}] : [])]);
    if (path === '/api/v1/repos/akadmin/unrelated/contents/proof') return send(403);
    return send(500, 'unexpected path');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const source = await readFile(new URL('ansiwise/templates/forgejo-build-credentials.sh.tpl', root), 'utf8');
  const render = program.steps.find(s => s.template === 'ansiwise/templates/forgejo-build-credentials.sh.tpl');
  let script = source;
  for (const [slot, value] of Object.entries(render.values)) script = script.replaceAll('<' + slot + '>', value);
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
  return {run, clean, privateFiles, users, commands, requests, get generation() {return generation;}, port};
}

test('first creation grants only the proof repository and returns exactly three fields', async () => {
  const f = await fixture({exists: false, granted: false});
  try {
    const r = await f.run(null); assert.equal(r.code, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), entry);
    assert.equal(f.generation, 1); assert.ok(!f.users.has(BOOTSTRAP));
    assert.ok(f.requests.some(r => r.method === 'PUT' && r.path.includes(REPO)));
    const unrelated = await fetch('http://127.0.0.1:' + f.port + '/api/v1/repos/akadmin/unrelated/contents/proof', {method: 'PUT', headers: {authorization: 'token ' + TOKEN}});
    assert.equal(unrelated.status, 403);
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
    await f.privateFiles();
  } finally {await f.clean();}
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
  for (const options of [{unreadable: true}, {apiFailure: true}, {absentPod: true}, {unrelated: true}, {repoAdmin: true}, {badUser: {restricted: false}}, {ownerToken: true}]) {
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
