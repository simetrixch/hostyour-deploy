import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {program, rendered, root} from './forgejo-plane-access-fake.mjs';

const TEMPLATE = 'ansiwise/templates/forgejo-ssh-host-key.sh.tpl';
const ENTRY = '<stage>/app/forgejo-host-key';
const PORT = '23', HOST = 'forgejo.master.example.org';
const wire = (type, body) => Buffer.concat([Buffer.from([0, 0, 0, type.length]), Buffer.from(type), Buffer.from(body)]).toString('base64');
const RSA = wire('ssh-rsa', 'exponent-and-modulus-of-the-fixture-key');
const OTHER_RSA = wire('ssh-rsa', 'exponent-and-modulus-of-another-key');
const ED25519 = wire('ssh-ed25519', 'public-key-of-the-fixture-ed25519-key');
const address = `[${HOST}]:${PORT}`;

// A stand-in ssh-keyscan answers what the test says on standard output and writes its arguments beside itself.
function produce({scan, mode = '--apply', entry = {}, exit = 0, host = HOST}) {
  const directory = mkdtempSync(join(tmpdir(), 'forgejo-ssh-host-key-'));
  try {
    writeFileSync(join(directory, 'answer'), scan);
    writeFileSync(join(directory, 'ssh-keyscan'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$*" > "${directory}/arguments"\ncat "${directory}/answer"\nexit ${exit}\n`);
    chmodSync(join(directory, 'ssh-keyscan'), 0o755);
    writeFileSync(join(directory, 'producer.sh'), rendered(readFileSync(new URL(TEMPLATE, root), 'utf8'),
      {'forgejo-ssh-port': PORT, 'forgejo-host': host}));
    const done = spawnSync('bash', [join(directory, 'producer.sh'), mode, '--', 'kubectl'], {
      input: JSON.stringify({entry, inputs: {}}), encoding: 'utf8', env: {PATH: `${directory}:${process.env.PATH}`},
    });
    // absent where the producer refused before it scanned
    const asked = join(directory, 'arguments');
    return {...done, arguments: existsSync(asked) ? readFileSync(asked, 'utf8').trim() : ''};
  } finally {
    rmSync(directory, {recursive: true, force: true});
  }
}

test('one ssh-rsa line is stored as the host-key field, without its address', () => {
  const done = produce({scan: `# ${HOST}:${PORT} SSH-2.0-fixture\n${address} ssh-rsa ${RSA}\n`});
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), {'host-key': `ssh-rsa ${RSA}`});
  assert.equal(done.arguments, `-T 10 -t rsa -p ${PORT} ${HOST}`);
});

// THE SCAN IS OF THE HOST THE INSTALLATION NAMES, never of one the program builds from the cluster's name. The
// planted installation is the one the review found: a master named master.digitacloud.app whose Forgejo host
// is stated as forgejo.digitacloud.app. The release bump pushes to the stated host, so the key trusted
// must be that host's, and a key line of the host built from the cluster's name is another host's.
test('PLANTED DEFECT: the scan asks the stated Forgejo host, and refuses the key of the host built from the cluster name', () => {
  const stated = 'forgejo.digitacloud.app', built = 'forgejo.master.digitacloud.app';
  const done = produce({host: stated, scan: `[${stated}]:${PORT} ssh-rsa ${RSA}\n`});
  assert.equal(done.status, 0, done.stderr);
  assert.equal(done.arguments, `-T 10 -t rsa -p ${PORT} ${stated}`);
  const other = produce({host: stated, scan: `[${built}]:${PORT} ssh-rsa ${RSA}\n`});
  assert.notEqual(other.status, 0, 'the key of the host built from the cluster name was accepted for the stated host');
  assert.equal(other.stdout, '');
});

test('PLANTED INNOCENT: a stated host that is the cluster-named one scans as it did before', () => {
  const done = produce({host: 'forgejo.master.digitacloud.app', scan: `[forgejo.master.digitacloud.app]:${PORT} ssh-rsa ${RSA}\n`});
  assert.equal(done.status, 0, done.stderr);
});

test('PLANTED DEFECT: a host that is no lowercase host name is refused before any scan', () => {
  for (const host of ['', 'Forgejo.Example.org', 'forgejo.example.org:22', 'forgejo.example.org/x', '-forgejo']) {
    const done = produce({host, scan: `[${host}]:${PORT} ssh-rsa ${RSA}\n`});
    assert.notEqual(done.status, 0, `${JSON.stringify(host)} was accepted`);
  }
});

test('a check holds only while the entry is the key the port answers now', () => {
  const scan = `${address} ssh-rsa ${RSA}\n`;
  assert.deepEqual(JSON.parse(produce({scan, mode: '--check', entry: {'host-key': `ssh-rsa ${RSA}`}}).stdout), {satisfied: true});
  assert.deepEqual(JSON.parse(produce({scan, mode: '--check', entry: {'host-key': `ssh-rsa ${OTHER_RSA}`}}).stdout), {satisfied: false});
  assert.deepEqual(JSON.parse(produce({scan, mode: '--check', entry: {}}).stdout), {satisfied: false});
});

test('PLANTED DEFECTS: every scan that is not exactly one RSA key line of the asked address is refused, and no key is printed', () => {
  const planted = [
    ['two ssh-rsa lines', `${address} ssh-rsa ${RSA}\n${address} ssh-rsa ${OTHER_RSA}\n`],
    ['a line that is no key', `${address} this is not a key line\n`],
    ['an ssh-rsa line without a readable key', `${address} ssh-rsa not-base64!\n`],
    ['an ssh-rsa line that holds another key type', `${address} ssh-rsa ${ED25519}\n`],
    ['an ssh-ed25519 line where RSA is asked for', `${address} ssh-ed25519 ${ED25519}\n`],
    ['a key for another address', `[forgejo.other.example.org]:${PORT} ssh-rsa ${RSA}\n`],
    ['no answer at all', ''],
    ['only comment lines', `# ${HOST}:${PORT} SSH-2.0-fixture\n`],
  ];
  for (const [name, scan] of planted) {
    for (const mode of ['--apply', '--check']) {
      const done = produce({scan, mode});
      assert.notEqual(done.status, 0, `${name} (${mode}) was accepted`);
      assert.equal(done.stdout, '', `${name} (${mode}) printed a result`);
      assert.ok(!done.stderr.includes(RSA) && !done.stderr.includes(OTHER_RSA), `${name} (${mode}) printed a key`);
    }
  }
  assert.notEqual(produce({scan: `${address} ssh-rsa ${RSA}\n`, exit: 1}).status, 0, 'a failed ssh-keyscan was accepted');
});

test('PLANTED INNOCENT: an address without a bracket and a comment line beside the key are accepted', () => {
  const done = produce({scan: `# ${HOST}:22 SSH-2.0-fixture\n${HOST} ssh-rsa ${RSA}\n`});
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), {'host-key': `ssh-rsa ${RSA}`});
});

// THE ROWS: the producer is rendered and run on the master beside the machine users, under the same words,
// and the policy of the build plane's secret reader reaches its entry.
const rowsOf = steps => {
  const render = steps.find(s => s.path === '/run/forgejo-ssh-host-key.sh');
  return {render, writer: steps.find(s => s.producer === '/run/forgejo-ssh-host-key.sh')};
};
const gate = ['secret_store_enabled', 'books_here_in_answers', 'build_plane_here_in_answers', 'plane_runs_here'];

function wiring(steps) {
  const problems = [], {render, writer} = rowsOf(steps);
  if (!render || !writer) return ['no rows'];
  if (render.template !== TEMPLATE || render.step !== 'write_file_from_template') problems.push('not the template');
  if (render.file_mode !== 448 || render.elevated !== true) problems.push('the producer is readable by others or not written as root');
  if (JSON.stringify(render.values) !== JSON.stringify({'forgejo-ssh-port': {answer: 'forgejo_ssh_port'}, 'forgejo-host': {answer: 'forgejo_host'}})) problems.push('wrong values');
  if (writer.step !== 'vault_kv_entry_from_command' || writer.path !== ENTRY || JSON.stringify(writer.fields) !== '["host-key"]') problems.push('wrong entry or fields');
  if (![render, writer].every(r => JSON.stringify(r.when) === JSON.stringify(gate))) problems.push('not guarded like the machine users');
  if (![render, writer].every(r => r.on_failure === 'exit')) problems.push('failure continued');
  if (steps.filter(s => s.path === ENTRY).length !== 1) problems.push('entry written twice');
  const policy = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read');
  const reads = (policy?.rules ?? '').split('\n').filter(line => line.includes(ENTRY));
  if (JSON.stringify(reads.map(line => line.trim())) !== JSON.stringify([`path "secret/data/${ENTRY}" { capabilities = ["read"] }`])) problems.push('the build reader has not exactly one read of the entry');
  return problems;
}

test('the host key is produced beside the machine users and read by the build reader alone', () => {
  assert.deepEqual(wiring(program.steps), []);
  const answers = program.answers.filter(a => a.name === 'forgejo_ssh_port');
  assert.equal(answers.length, 1, 'deploy-platform-services declares the port the scan uses');
  const hosts = program.answers.filter(a => a.name === 'forgejo_host');
  assert.equal(hosts.length, 1, 'deploy-platform-services declares the host the scan uses');
  assert.deepEqual([hosts[0].required, hosts[0].shape], [true, 'hostname']);
  const others = program.steps.filter(s => s.step === 'vault_policy' && s.name !== '<cluster>-build-read' && (s.rules ?? '').includes('forgejo-host-key'));
  assert.deepEqual(others, [], 'a policy other than the build reader reads the host key');
  for (const defect of [
    steps => { rowsOf(steps).writer.when.pop(); },
    steps => { rowsOf(steps).writer.fields = ['host-key', 'extra']; },
    steps => { rowsOf(steps).render.file_mode = 420; },
    steps => { delete rowsOf(steps).render.elevated; },
    steps => { rowsOf(steps).render.values['forgejo-host'] = {answer: 'fqdn'}; },
    steps => { delete rowsOf(steps).render.values['forgejo-host']; rowsOf(steps).render.values.fqdn = {answer: 'fqdn'}; },
    steps => { rowsOf(steps).writer.on_failure = 'continue'; },
    steps => { steps.splice(steps.indexOf(rowsOf(steps).writer), 1); },
    steps => { const p = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read'); p.rules = p.rules.replace(/.*forgejo-host-key.*\n/, ''); },
    steps => { const p = steps.find(s => s.step === 'vault_policy' && s.name === '<cluster>-build-read'); p.rules = p.rules.replace(`${ENTRY}" { capabilities = ["read"]`, `${ENTRY}" { capabilities = ["read", "update"]`); },
  ]) {
    const changed = structuredClone(program.steps); defect(changed);
    assert.notDeepEqual(wiring(changed), [], String(defect));
  }
});
