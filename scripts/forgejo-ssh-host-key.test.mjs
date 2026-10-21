import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {CANARY, assertRefused, privateOutcome, program, root, unreadableInputs, writeProducer} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/forgejo-ssh-host-key.sh.tpl';
const ENTRY = '<stage>/app/forgejo-host-key';
const KEY_FILE = '/data/ssh/gitea.rsa.pub';
const PRIVATE_FILE = '/data/ssh/gitea.rsa';
const SECOND_KEY_FILE = '/data/ssh/gogs.rsa.pub';
const POD = 'fixture-pod';
const wire = (type, body) => Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type), Buffer.from(body)]).toString('base64');
const RSA = wire('ssh-rsa', 'exponent-and-modulus-of-the-fixture-key');
const OTHER_RSA = wire('ssh-rsa', 'exponent-and-modulus-of-another-key');
const ED25519 = wire('ssh-ed25519', 'public-key-of-the-fixture-ed25519-key');
const PRIVATE_MARKER = 'FIXTURE-PRIVATE-KEY-MATERIAL';
const PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----\n${PRIVATE_MARKER}\n-----END OPENSSH PRIVATE KEY-----\n`;
const ready = name => ({metadata: {name}, status: {podIP: '127.0.0.1', conditions: [{type: 'Ready', status: 'True'}]}});

const rowOf = steps => steps.find(s => s.path === '/run/forgejo-ssh-host-key.sh');
const POD_WORDS = ['forgejo-namespace', 'forgejo-pod-selector', 'forgejo-container'];

/** What the producer asks the cluster, in order, when it does what it is for: it names the Forgejo pod and
 * reads one file of it. */
const askedOfCluster = [
  ['--request-timeout=10s', '-n', 'forgejo', 'get', 'pods', '-l', 'app.kubernetes.io/name=forgejo', '-o', 'json'],
  ['--request-timeout=10s', '-n', 'forgejo', 'exec', POD, '-c', 'forgejo', '--', 'cat', KEY_FILE],
];

/** A fake cluster: a kubectl that hands its argv to this test's server, the Forgejo pods the test names and the
 * files of the Forgejo container, and a stand-in ssh-keyscan that records that it was run and answers a key. */
async function fixture({files = {[KEY_FILE]: `ssh-rsa ${RSA}\n`}, pods = [POD], mutate, scanned = `forgejo.example.org ssh-rsa ${OTHER_RSA}\n`} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-ssh-host-key-'));
  const calls = [];
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const {argv} = JSON.parse(text);
    calls.push(argv);
    const send = (status, data) => { res.writeHead(status, {'content-type': 'application/json'}); res.end(typeof data === 'string' ? data : JSON.stringify(data)); };
    if (argv.includes('get') && argv.includes('pods')) return send(200, {items: pods.map(ready)});
    const args = argv.slice(argv.indexOf('--') + 1);
    if (argv.includes('exec') && args[0] === 'cat') return args[1] in files ? send(200, files[args[1]]) : send(500, 'cat: no such file');
    return send(500, 'unexpected command');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const clean = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(directory, {recursive: true, force: true}); };
  try {
    const {producer, kubectl} = await writeProducer(directory, TEMPLATE, rowOf(program.steps).values, {mutate, port: server.address().port});
    await writeFile(join(directory, 'ssh-keyscan'), `#!/usr/bin/env bash\ntouch "${directory}/scanned"\ncat <<'EOF'\n${scanned}EOF\n`);
    await chmod(join(directory, 'ssh-keyscan'), 0o755);
    const run = (entry, mode = '--apply', raw = undefined) => new Promise((resolve, reject) => {
      const child = spawn('bash', [producer, mode, '--', kubectl], {cwd: directory, env: {...process.env, PATH: `${directory}:${process.env.PATH}`}});
      let stdout = '', stderr = ''; child.stdout.on('data', d => stdout += d); child.stderr.on('data', d => stderr += d);
      child.on('error', reject);
      child.on('close', code => { try { resolve(privateOutcome({code, stdout, stderr}, [PRIVATE_MARKER, PRIVATE_KEY])); } catch (error) { reject(error); } });
      child.stdin.end(raw ?? JSON.stringify({entry, inputs: {}}));
    });
    const scannedTheNetwork = () => readFile(join(directory, 'scanned')).then(() => true, () => false);
    return {run, clean, calls, scannedTheNetwork};
  } catch (error) { await clean(); throw error; }
}

/** Every way a run strayed from "name the Forgejo pod and read the public half of its host key": a command
 * the cluster was asked beyond those two, a file other than the one the server writes its public key to, and any
 * scan of the network. */
async function strayed(f) {
  const found = [];
  if (JSON.stringify(f.calls) !== JSON.stringify(askedOfCluster)) found.push(`asked the cluster ${JSON.stringify(f.calls)}`);
  if (await f.scannedTheNetwork()) found.push('scanned the network');
  return found;
}

async function using(options, body) {
  const f = await fixture(options);
  try { return await body(f); } finally { await f.clean(); }
}

test('the public key of the Forgejo pod is stored as the host-key field, read in the pod and nowhere else', async () => {
  await using({files: {[KEY_FILE]: `ssh-rsa ${RSA}\n`, [PRIVATE_FILE]: PRIVATE_KEY, [SECOND_KEY_FILE]: `ssh-rsa ${OTHER_RSA}\n`}}, async f => {
    const done = await f.run(null);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), {'host-key': `ssh-rsa ${RSA}`});
    assert.ok(!done.stderr.includes(PRIVATE_MARKER) && !done.stdout.includes(PRIVATE_MARKER));
    assert.deepEqual(await strayed(f), []);
  });
});

test('a check holds only while the entry is the key the pod serves now', async () => {
  for (const [entry, satisfied] of [
    [{'host-key': `ssh-rsa ${RSA}`}, true],
    [{'host-key': `ssh-rsa ${OTHER_RSA}`}, false],
    [{}, false],
    [{'host-key': `ssh-rsa ${RSA}`, extra: 'x'}, false],
  ]) {
    await using({}, async f => {
      const done = await f.run(entry, '--check');
      assert.equal(done.code, 0, done.stderr);
      assert.deepEqual(JSON.parse(done.stdout), {satisfied});
      assert.deepEqual(await strayed(f), []);
    });
  }
});

// THE SOURCE IS THE SERVER, NEVER THE NETWORK. The review that refused the scan: whatever answers a DNS name and a
// port is not Forgejo, and a key stored from it is trusted by the release bump's push. Each planted producer below
// is one way back to that, run against the same fixture as the producer as it stands.
const READ_THE_FILE = /text = access\.kube\(\[[^\n]*\bKEY_FILE\][^\n]*\)/;
const planted = {
  'scans the Forgejo SSH port': template => {
    assert.match(template, READ_THE_FILE);
    return template.replace(READ_THE_FILE, "text = subprocess.run(['ssh-keyscan', '-t', 'rsa', 'forgejo.example.org'], capture_output=True, text=True).stdout.replace('forgejo.example.org ', '')")
      .replace('import sys\n', 'import subprocess\nimport sys\n');
  },
  'reads the second key file of the server': template => {
    assert.ok(template.includes(`KEY_FILE = '${KEY_FILE}'`));
    return template.replace(`KEY_FILE = '${KEY_FILE}'`, `KEY_FILE = '${SECOND_KEY_FILE}'`);
  },
  'reads the private half': template => {
    assert.ok(template.includes(`KEY_FILE = '${KEY_FILE}'`));
    return template.replace(`KEY_FILE = '${KEY_FILE}'`, `KEY_FILE = '${PRIVATE_FILE}'`);
  },
};

test('PLANTED DEFECTS: a producer that scans the network or reads any other file is found, and the one as it stands is not', async () => {
  const files = {[KEY_FILE]: `ssh-rsa ${RSA}\n`, [SECOND_KEY_FILE]: `ssh-rsa ${OTHER_RSA}\n`, [PRIVATE_FILE]: PRIVATE_KEY};
  for (const [name, mutate] of Object.entries(planted)) {
    await using({files, mutate}, async f => {
      await f.run(null);
      assert.notDeepEqual(await strayed(f), [], `a producer that ${name} was not found`);
    });
  }
  await using({files}, async f => {
    await f.run(null);
    assert.deepEqual(await strayed(f), []);
  });
});

test('PLANTED DEFECT: the template names no scanner and no socket', async () => {
  const text = await readFile(new URL(TEMPLATE, root), 'utf8');
  const network = /ssh-keyscan|socket|urllib|http\.client|subprocess/;
  assert.doesNotMatch(text, network);
  for (const line of ["subprocess.run(['ssh-keyscan', host])", 'import socket', 'urllib.request.urlopen(url)']) {
    assert.match(`${text}\n${line}\n`, network);
  }
});

test('PLANTED DEFECTS: every file that is not exactly one RSA public key line is refused, and nothing of it is printed', async () => {
  const cases = [
    ['an empty file', ''],
    ['only a newline', '\n'],
    ['two ssh-rsa lines', `ssh-rsa ${RSA}\nssh-rsa ${OTHER_RSA}\n`],
    ['a line that is no key', 'this is not a key line\n'],
    ['an ssh-rsa line without a readable key', 'ssh-rsa not-base64!\n'],
    ['an ssh-rsa line that holds another key type', `ssh-rsa ${ED25519}\n`],
    ['an ssh-ed25519 line where RSA is asked for', `ssh-ed25519 ${ED25519}\n`],
    ['a key line with a comment after it', `ssh-rsa ${RSA} root@forgejo\n`],
    ['a key line of another address', `forgejo.example.org ssh-rsa ${RSA}\n`],
    ['a private key', PRIVATE_KEY],
  ];
  for (const [name, content] of cases) {
    for (const mode of ['--apply', '--check']) {
      await using({files: {[KEY_FILE]: content}}, async f => {
        const done = await f.run({'host-key': `ssh-rsa ${RSA}`}, mode);
        assert.notEqual(done.code, 0, `${name} (${mode}) was accepted`);
        assert.equal(done.stdout, '', `${name} (${mode}) printed a result`);
        for (const secret of [RSA, OTHER_RSA, ED25519, PRIVATE_MARKER]) assert.ok(!done.stderr.includes(secret), `${name} (${mode}) printed what the file held`);
      });
    }
  }
});

test('PLANTED INNOCENT: a key line without a final newline is the same key', async () => {
  await using({files: {[KEY_FILE]: `ssh-rsa ${RSA}`}}, async f => {
    const done = await f.run(null);
    assert.equal(done.code, 0, done.stderr);
    assert.deepEqual(JSON.parse(done.stdout), {'host-key': `ssh-rsa ${RSA}`});
  });
});

test('PLANTED DEFECTS: no key is stored where the pod cannot be named or the file cannot be read', async () => {
  for (const [name, options, reads] of [
    ['no ready pod', {pods: []}, false],
    ['two ready pods', {pods: [POD, 'second-pod']}, false],
    ['no key file in the pod', {files: {}}, true],
  ]) {
    for (const mode of ['--apply', '--check']) {
      await using(options, async f => {
        const done = await f.run({}, mode);
        assert.notEqual(done.code, 0, `${name} (${mode}) was accepted`);
        assert.equal(done.stdout, '', `${name} (${mode}) printed a result`);
        assert.equal(f.calls.some(argv => argv.includes('exec')), reads, `${name} (${mode}) read a file of the wrong pod count`);
        assert.equal(await f.scannedTheNetwork(), false, `${name} (${mode}) fell back to a scan`);
      });
    }
  }
});

// THE ROWS: the producer is rendered and run on the master beside the machine users, in the Forgejo pod they use, and
// the policy of the build plane's secret reader reaches its entry.
const rowsOf = steps => ({
  module: steps.find(s => s.path === '/run/forgejo-plane-access.py'),
  render: rowOf(steps),
  writer: steps.find(s => s.producer === '/run/forgejo-ssh-host-key.sh'),
  sibling: steps.find(s => s.path === '/run/forgejo-machine-user-hostyour-cloud-bump.sh'),
});
const gate = ['secret_store_enabled', 'books_here_in_answers', 'build_plane_here_in_answers', 'plane_runs_here'];

function wiring(steps) {
  const problems = [], {module, render, writer, sibling} = rowsOf(steps);
  if (!render || !writer || !module || !sibling) return ['no rows'];
  if (render.template !== TEMPLATE || render.step !== 'write_file_from_template') problems.push('not the template');
  if (render.file_mode !== 448 || render.elevated !== true) problems.push('the producer is readable by others or not written as root');
  const wanted = {...Object.fromEntries(POD_WORDS.map(word => [word, sibling.values[word]])), 'forgejo-plane-access-module': module.path};
  if (JSON.stringify(render.values) !== JSON.stringify(wanted)) problems.push(`the producer is not told the pod of the machine users and the access module: ${JSON.stringify(render.values)}`);
  if (steps.indexOf(module) > steps.indexOf(render)) problems.push('the access module is written after the producer that loads it');
  if (writer.step !== 'vault_kv_entry_from_command' || writer.path !== ENTRY || JSON.stringify(writer.fields) !== '["host-key"]') problems.push('wrong entry or fields');
  if (![render, writer].every(r => JSON.stringify(r.when) === JSON.stringify(gate))) problems.push('not guarded like the machine users');
  if (![render, writer].every(r => r.on_failure === 'exit')) problems.push('failure continued');
  if (steps.filter(s => s.path === ENTRY).length !== 1) problems.push('entry written twice');
  const policy = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read');
  const reads = (policy?.rules ?? '').split('\n').filter(line => line.includes(ENTRY));
  if (JSON.stringify(reads.map(line => line.trim())) !== JSON.stringify([`path "secret/data/${ENTRY}" { capabilities = ["read"] }`])) problems.push('the build reader has not exactly one read of the entry');
  return problems;
}

test('the host key is produced beside the machine users, in their pod, and read by the build reader alone', () => {
  assert.deepEqual(wiring(program.steps), []);
  const others = program.steps.filter(s => s.step === 'vault_policy' && s.name !== '<cluster>-build-read' && (s.rules ?? '').includes('forgejo-host-key'));
  assert.deepEqual(others, [], 'a policy other than the build reader reads the host key');
  for (const defect of [
    steps => { rowsOf(steps).writer.when.pop(); },
    steps => { rowsOf(steps).writer.fields = ['host-key', 'extra']; },
    steps => { rowsOf(steps).render.file_mode = 420; },
    steps => { delete rowsOf(steps).render.elevated; },
    steps => { rowsOf(steps).render.values['forgejo-container'] = 'sidecar'; },
    steps => { rowsOf(steps).render.values['forgejo-namespace'] = 'default'; },
    steps => { delete rowsOf(steps).render.values['forgejo-plane-access-module']; },
    steps => { rowsOf(steps).render.values['forgejo-host'] = {answer: 'fqdn'}; },
    steps => { const {module, render} = rowsOf(steps); steps.splice(steps.indexOf(module), 1); steps.splice(steps.indexOf(render) + 1, 0, module); },
    steps => { rowsOf(steps).writer.on_failure = 'continue'; },
    steps => { steps.splice(steps.indexOf(rowsOf(steps).writer), 1); },
    steps => { const p = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read'); p.rules = p.rules.replace(/.*forgejo-host-key.*\n/, ''); },
    steps => { const p = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read'); p.rules = p.rules.replace(`${ENTRY}" { capabilities = ["read"]`, `${ENTRY}" { capabilities = ["read", "update"]`); },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), [], String(defect));
  }
});

test('a producer handed input it cannot read refuses by name and repeats none of it', async () => {
  await using({}, async f => {
    for (const [reason, raw] of unreadableInputs(CANARY)) assertRefused(await f.run(null, '--apply', raw), reason, [CANARY]);
  });
});
