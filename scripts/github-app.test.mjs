import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {createVerify, generateKeyPairSync} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {CANARY, assertRefused, privateOutcome, program, rendered, root, unreadableInputs} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/github-app.sh.tpl';
const PRODUCER = '/run/github-app.sh';
const ENTRY = '<stage>/app/github-app';
const FIELDS = ['app-id', 'installation-id', 'private-key', 'owner'];
const GATE = ['secret_store_enabled', 'books_here_in_answers'];
const VALUES = {'secrets-directory': '/srv/hostyour-cloud/secrets', stage: {answer: 'stage'}, 'github-api': 'https://api.github.com'};
const COMPOSED = "'<secrets-directory>/secrets.<stage>'";
// The answer of deploy-branch that fills each key of the secrets file the producer reads.
const ANSWERS = {'app-id': 'github_app_id', 'installation-id': 'github_app_installation_id', 'private-key': 'github_app_private_key', owner: 'github_app_owner'};

const branch = JSON.parse(execFileSync('yq', ['-o=json', '.', new URL('ansiwise/programs/deploy-branch.yaml', root).pathname], {encoding: 'utf8'}));
const fill = branch.steps.find(step => step.step === 'fill_key_value_file' && Object.hasOwn(step.values, 'GITHUB_APP_ID'));
const KEYS = Object.fromEntries(FIELDS.map(field => [field, Object.keys(fill.values).find(key => fill.values[key].answer === ANSWERS[field])]));
const template = await readFile(new URL(TEMPLATE, root), 'utf8');

function wiring(steps, text = template) {
  const problems = [];
  const writers = steps.filter(s => s.path === ENTRY);
  if (writers.length !== 1) problems.push(`the entry has ${writers.length} writers`);
  const writer = writers[0], render = steps.find(s => s.path === PRODUCER);
  const renderAt = steps.indexOf(render), writerAt = steps.indexOf(writer);
  const demand = steps.slice(0, Math.max(renderAt, 0)).findLast(s => s.step === 'require_commands');
  if (writer?.step !== 'vault_kv_entry_from_command' || writer.producer !== PRODUCER) problems.push('the writer is not the producer step');
  if (JSON.stringify(writer?.fields) !== JSON.stringify(FIELDS)) problems.push('the writer carries other fields');
  if (writer && Object.hasOwn(writer, 'fields_from_answers')) problems.push('the writer takes a field from an answer');
  if (!render || render.step !== 'write_file_from_template' || render.template !== TEMPLATE) problems.push('no renderer of the producer');
  if (render && (render.file_mode !== 448 || render.elevated !== true)) problems.push('the producer is not owner-only and elevated');
  if (JSON.stringify(render?.values) !== JSON.stringify(VALUES)) problems.push('the renderer fills other values');
  if (JSON.stringify(demand?.commands) !== JSON.stringify(['openssl', 'python3'])) problems.push('no demand for openssl and python3 before the renderer');
  if (!(steps.indexOf(demand) < renderAt && renderAt < writerAt)) problems.push('the rows are out of order');
  for (const [name, row] of Object.entries({demand, render, writer})) {
    if (JSON.stringify(row?.when) !== JSON.stringify(GATE)) problems.push(`${name}: not guarded to a books cluster with a secret store`);
    if (row?.on_failure !== 'exit') problems.push(`${name}: failure continued`);
  }
  if (text.split(COMPOSED).length !== 2) problems.push('the template does not compose the secrets file once');
  const slots = [...new Set([...text.matchAll(/<([a-z][a-z0-9-]*)>/g)].map(([, name]) => name))].sort();
  if (JSON.stringify(slots) !== JSON.stringify(Object.keys(VALUES).sort())) problems.push('the template has other slots than the renderer fills');
  if (`${render?.values?.['secrets-directory']}/secrets.<stage>` !== `${writer?.repository}/${program.defaults.secrets_path}`) problems.push('the producer reads another file than the one deploy-branch fills');
  return problems;
}

test('the Vault entry of the App is written by the producer, which asks GitHub first, and reads the file deploy-branch fills', () => {
  assert.deepEqual(wiring(program.steps), []);
  assert.deepEqual(KEYS, {'app-id': 'GITHUB_APP_ID', 'installation-id': 'GITHUB_APP_INSTALLATION_ID', 'private-key': 'GITHUB_APP_PRIVATE_KEY', owner: 'GITHUB_APP_OWNER'});
  assert.equal(fill.path, `${VALUES['secrets-directory']}/secrets.<stage>`);
  assert.equal(fill.run_answer, 'stage');
});

test('PLANTED DEFECTS: each way the check or its wiring can be lost goes red', () => {
  const rows = steps => ({
    demand: steps.slice(0, steps.findIndex(s => s.path === PRODUCER)).findLast(s => s.step === 'require_commands'),
    render: steps.find(s => s.path === PRODUCER),
    writer: steps.find(s => s.path === ENTRY),
  });
  const defects = {
    'the writer back to vault_kv_entry': steps => { rows(steps).writer.step = 'vault_kv_entry'; },
    'owner dropped from the fields': steps => { rows(steps).writer.fields = FIELDS.slice(0, 3); },
    'a field from an answer': steps => { rows(steps).writer.fields_from_answers = ['owner=github_app_owner']; },
    'a secrets-directory of another directory': steps => { rows(steps).render.values['secrets-directory'] = '/srv/other/secrets'; },
    'a github-api other than GitHub': steps => { rows(steps).render.values['github-api'] = 'https://api.github.example'; },
    'a second writer of the entry': steps => steps.push({step: 'vault_kv_entry', path: ENTRY, fields: ['owner=GITHUB_APP_OWNER'], when: GATE, on_failure: 'exit'}),
    'openssl dropped from the require row': steps => { rows(steps).demand.commands = ['python3']; },
    'the require row removed': steps => { steps.splice(steps.indexOf(rows(steps).demand), 1); },
    'the renderer after the writer': steps => { const {render, writer} = rows(steps); steps.splice(steps.indexOf(render), 1); steps.splice(steps.indexOf(writer) + 1, 0, render); },
    'the producer not elevated': steps => { rows(steps).render.elevated = false; },
  };
  for (const row of ['demand', 'render', 'writer']) {
    defects[`${row}: a guard dropped`] = steps => { rows(steps)[row].when = rows(steps)[row].when.filter(c => c !== 'books_here_in_answers'); };
    defects[`${row}: on_failure continue`] = steps => { rows(steps)[row].on_failure = 'continue'; };
  }
  for (const [name, plant] of Object.entries(defects)) {
    const steps = structuredClone(program.steps);
    plant(steps);
    assert.notDeepEqual(wiring(steps), [], `the planted defect "${name}" stays green`);
  }
  assert.notDeepEqual(wiring(program.steps, template + COMPOSED), [], 'a second composition of the file stays green');
  assert.notDeepEqual(wiring(program.steps, template.replace(COMPOSED, "'<secrets-directory>/secrets.test'")), [], 'a file that is not the stage\'s stays green');
});

// ---------------------------------------------------------------- the producer, run against a fake GitHub

const APP_ID = '317041', INSTALLATION = '4242';
const {privateKey, publicKey} = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: {type: 'pkcs1', format: 'pem'},
  publicKeyEncoding: {type: 'spki', format: 'pem'},
});
const KEY_LINE = privateKey.trimEnd().replaceAll('\n', '\\n');
const KEY_BODY = privateKey.split('\n')[1];
const decode = part => JSON.parse(Buffer.from(part, 'base64url').toString());

// GitHub's answer for the installation: 200 with the account for a JWT of the App's own key, 401 for any other.
async function startGithub(installations) {
  const requests = [], tokens = [];
  const server = createServer((req, res) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (token) tokens.push(token);
    const [header, payload, signature] = (token ?? '..').split('.');
    let authenticated = false;
    try {
      const claims = decode(payload), now = Date.now() / 1000;
      authenticated = decode(header).alg === 'RS256' && claims.iss === APP_ID && claims.iat <= now && claims.exp > now && claims.exp - claims.iat <= 600
        && createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url');
    } catch { authenticated = false; }
    requests.push({method: req.method, url: req.url, authenticated});
    const send = (status, body) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(JSON.stringify(body)); };
    const id = /^\/app\/installations\/(\d+)$/.exec(req.url)?.[1];
    if (req.method !== 'GET' || id === undefined) return send(404, {message: 'Not Found'});
    if (!authenticated) return send(401, {message: 'Bad credentials'});
    return id in installations ? send(installations[id].status ?? 200, installations[id]) : send(404, {message: 'Not Found'});
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const stop = () => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
  return {port: server.address().port, requests, tokens, stop};
}

const secretsFile = (values, extra = '') => [
  '# The App of the fixture installation',
  `export ${KEYS['app-id']}=${values['app-id']}`,
  `${KEYS['installation-id']}='${values['installation-id']}'`,
  `${KEYS['private-key']}="${values['private-key']}"`,
  `${KEYS.owner}=${values.owner}`,
  extra,
].join('\n') + '\n';

/** Renders the producer into a directory of its own beside a secrets file and a fake GitHub, and runs it as the step does. */
async function fixture({login = 'digitaplatform', installations, unreachable = false, filled = {}} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'github-app-'));
  const scratch = join(directory, 'tmp');
  await mkdir(scratch);
  const github = await startGithub(installations ?? {[INSTALLATION]: {account: {login}}});
  if (unreachable) await github.stop();
  const values = {'app-id': APP_ID, 'installation-id': INSTALLATION, 'private-key': KEY_LINE, owner: 'digitaplatform', ...filled};
  const secrets = join(directory, 'secrets.test'), producer = join(directory, 'producer.sh');
  await writeFile(secrets, secretsFile(values));
  await writeFile(producer, rendered(template, {'secrets-directory': directory, stage: 'test', 'github-api': `http://127.0.0.1:${github.port}`}));
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/proxy/i.test(name)));
  const leaked = () => [privateKey, KEY_LINE, KEY_BODY, ...github.tokens];
  const run = (mode, entry, raw = undefined) => new Promise((resolve, reject) => {
    const child = spawn('bash', [producer, mode, '--'], {cwd: directory, env: {...env, TMPDIR: scratch}});
    let stdout = '', stderr = '';
    child.stdout.on('data', d => stdout += d);
    child.stderr.on('data', d => stderr += d);
    child.on('error', reject);
    child.on('close', code => {
      try {
        for (const secret of leaked()) assert.ok(!stderr.includes(secret), 'the producer disclosed the key or a token on stderr');
        resolve(privateOutcome({code, stdout, stderr}, leaked()));
      } catch (error) { reject(error); }
    });
    child.stdin.end(raw ?? JSON.stringify({entry, inputs: {}}));
  });
  const clean = async () => { await github.stop(); await rm(directory, {recursive: true, force: true}); };
  return {run, clean, secrets, github, values, scratchEmpty: async () => assert.deepEqual(await readdir(scratch), [], 'the key file stayed in the temporary directory')};
}

async function using(options, body) {
  const f = await fixture(options);
  try { await body(f); } finally { await f.clean(); }
}

const mismatch = (f, typed, belongs) => `GITHUB_APP_OWNER in ${f.secrets} is ${typed}, and the installation ${INSTALLATION} belongs to ${belongs}; correct GITHUB_APP_OWNER in that file`;
const asked = (f, count) => {
  assert.equal(f.github.requests.length, count, 'the number of requests GitHub received');
  assert.ok(f.github.requests.every(r => r.method === 'GET' && r.url === `/app/installations/${INSTALLATION}` && r.authenticated), 'GitHub received a request that is not the App\'s own');
};

test('RED 1: an installation of account A and the owner B in the file refuses the check even for the entry that holds the file\'s values', async () => {
  await using({filled: {owner: 'simetrixch'}}, async f => {
    const result = await f.run('--check', f.values);
    assert.equal(result.code, 65);
    assertRefused(result, mismatch(f, 'simetrixch', 'digitaplatform'), [privateKey, KEY_LINE]);
    asked(f, 1);
    await f.scratchEmpty();
  });
});

test('RED 2: the same mismatch refuses the apply and prints nothing, so the step has nothing to write', async () => {
  await using({filled: {owner: 'simetrixch'}}, async f => {
    const result = await f.run('--apply', null);
    assert.equal(result.code, 65);
    assert.equal(result.stdout, '');
    assertRefused(result, mismatch(f, 'simetrixch', 'digitaplatform'), [privateKey, KEY_LINE]);
    asked(f, 1);
    await f.scratchEmpty();
  });
});

test('INNOCENT: the owner typed in another case than the account is the account; check, apply and check again answer as the step reads them', async () => {
  await using({filled: {owner: 'DigitaPlatform'}}, async f => {
    const empty = await f.run('--check', null);
    assert.equal(empty.code, 0);
    assert.deepEqual(JSON.parse(empty.stdout), {satisfied: false});
    const applied = await f.run('--apply', null);
    assert.equal(applied.code, 0);
    const answer = JSON.parse(applied.stdout);
    assert.deepEqual(answer, f.values);
    assert.equal(answer['private-key'], KEY_LINE);
    assert.ok(answer['private-key'].includes('\\n') && !answer['private-key'].includes('\n'), 'the key is one line with \\n');
    assert.equal(answer.owner, 'DigitaPlatform');
    const held = await f.run('--check', answer);
    assert.equal(held.code, 0);
    assert.deepEqual(JSON.parse(held.stdout), {satisfied: true});
    asked(f, 3);
    await f.scratchEmpty();
  });
});

test('an entry that differs from the file in one field, or holds a further one, is not satisfied', async () => {
  await using({}, async f => {
    const held = (change) => ({...f.values, ...change});
    for (const entry of [held({owner: 'DigitaPlatform'}), held({owner: 'simetrixch'}), held({'app-id': '1'}), held({'installation-id': '1'}), held({'private-key': 'x'}), held({further: 'field'}), {owner: 'digitaplatform'}, {}]) {
      const result = await f.run('--check', entry);
      assert.deepEqual(JSON.parse(result.stdout), {satisfied: false}, JSON.stringify(Object.keys(entry)));
    }
    assert.deepEqual(JSON.parse((await f.run('--check', f.values)).stdout), {satisfied: true});
  });
});

test('the secrets file is read with the grammar of the installer: the last assignment wins, a comment and an export are skipped, quotes are removed', async () => {
  await using({}, async f => {
    const text = secretsFile({...f.values, owner: 'simetrixch'}, `# GITHUB_APP_OWNER=simetrixch\nexport ${KEYS.owner}= "DigitaPlatform"  \n`);
    await writeFile(f.secrets, text);
    const result = await f.run('--apply', null);
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), {...f.values, owner: 'DigitaPlatform'});
  });
});

test('GitHub that does not name the installation, answers other than 200 or without an account, or cannot be reached refuses with exit 69 and names the installation', async () => {
  await using({filled: {'installation-id': '999'}}, async f => {
    const result = await f.run('--check', null);
    assert.equal(result.code, 69);
    assertRefused(result, 'GitHub answered HTTP 404 for the installation 999', [privateKey, KEY_LINE]);
    assert.equal(f.github.requests.length, 1);
  });
  await using({installations: {[INSTALLATION]: {status: 201, account: {login: 'digitaplatform'}}}}, async f => {
    const result = await f.run('--apply', null);
    assert.equal(result.code, 69);
    assertRefused(result, `GitHub answered HTTP 201 for the installation ${INSTALLATION}`, [privateKey, KEY_LINE]);
  });
  await using({installations: {[INSTALLATION]: {account: null}}}, async f => {
    const result = await f.run('--apply', null);
    assert.equal(result.code, 69);
    assertRefused(result, `GitHub's answer for the installation ${INSTALLATION} carries no account login`, [privateKey, KEY_LINE]);
  });
  await using({installations: {[INSTALLATION]: {account: {login: 'not a login'}}}}, async f => {
    const result = await f.run('--apply', null);
    assert.equal(result.code, 69);
    assertRefused(result, `GitHub's answer for the installation ${INSTALLATION} carries no account login`, [privateKey, KEY_LINE]);
  });
  await using({unreachable: true}, async f => {
    const result = await f.run('--check', null);
    assert.equal(result.code, 69);
    assertRefused(result, `GitHub could not be reached for the installation ${INSTALLATION}`, [privateKey, KEY_LINE]);
    await f.scratchEmpty();
  });
});

test('a secrets file that cannot be used refuses before any request and names the key and the file', async () => {
  const cases = [
    ['an empty owner', {owner: ''}, f => `GITHUB_APP_OWNER is missing or empty in ${f.secrets}`],
    ['an owner still marked unfilled', {owner: '<owner>'}, f => `GITHUB_APP_OWNER in ${f.secrets} still holds the text that marks it unfilled`],
    ['an owner that is no login', {owner: 'bad/owner!'}, f => `GITHUB_APP_OWNER in ${f.secrets} is not a GitHub account login (letters, digits and hyphens only)`],
    ['an installation id with a letter', {'installation-id': '42x'}, f => `GITHUB_APP_INSTALLATION_ID in ${f.secrets} is not all digits`],
    ['an empty App id and an empty owner at once', {'app-id': '', owner: ''}, f => `GITHUB_APP_ID is missing or empty in ${f.secrets}; GITHUB_APP_OWNER is missing or empty in ${f.secrets}`],
  ];
  for (const [name, filled, reason] of cases) {
    await using({filled}, async f => {
      for (const mode of ['--check', '--apply']) {
        const result = await f.run(mode, null);
        assert.equal(result.code, 65, name);
        assertRefused(result, reason(f), [privateKey, KEY_LINE, 'bad/owner!']);
      }
      assert.equal(f.github.requests.length, 0, `${name}: GitHub was asked`);
    });
  }
});

test('a key missing from the file, a file with a carriage return and a file that is not there refuse before any request', async () => {
  await using({}, async f => {
    await writeFile(f.secrets, secretsFile(f.values).replace(/^GITHUB_APP_PRIVATE_KEY=.*\n/m, ''));
    assertRefused(await f.run('--apply', null), `GITHUB_APP_PRIVATE_KEY is missing or empty in ${f.secrets}`, [privateKey, KEY_LINE]);
    await writeFile(f.secrets, secretsFile(f.values).replaceAll('\n', '\r\n'));
    assertRefused(await f.run('--apply', null), `${f.secrets} carries a carriage return, and a credential read out of it would carry one too; rewrite the file with unix line endings before this runs again`, [privateKey, KEY_LINE]);
    await rm(f.secrets);
    assertRefused(await f.run('--apply', null), `${f.secrets} cannot be read`, [privateKey, KEY_LINE]);
    assert.equal(f.github.requests.length, 0);
  });
});

test('a key openssl cannot sign with refuses with exit 65 and leaves nothing of it behind', async () => {
  await using({filled: {'private-key': 'not-a-key'}}, async f => {
    const result = await f.run('--apply', null);
    assert.equal(result.code, 65);
    assertRefused(result, `GITHUB_APP_PRIVATE_KEY in ${f.secrets} is not a private key openssl can sign with`, ['not-a-key']);
    assert.equal(f.github.requests.length, 0);
    await f.scratchEmpty();
  });
});

test('an input the step could not have sent refuses without repeating it, and so does a mode the step never uses', async () => {
  await using({}, async f => {
    for (const [reason, raw] of unreadableInputs(CANARY)) {
      const result = await f.run('--check', null, raw);
      assert.equal(result.code, 65);
      assertRefused(result, reason, [CANARY, privateKey, KEY_LINE]);
    }
    assert.equal(f.github.requests.length, 0);
    const result = await f.run('--rotate', null);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, '');
  });
});
