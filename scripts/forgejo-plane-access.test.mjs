// What a credential producer says when it refuses: the shared module's finish() writes one marked, plain line
// on stderr (the reader in ansiwise-plugins shows it in the run log), and nothing else of the producer's
// output is ever marked. The census reads every refuse() out of the real sources, the audit holds every
// expression a refusal formats to a name that is public or a value validated before it is formatted, and the
// four producer suites run under a recorder so a refuse() no fault fixture reaches turns this suite red.
import assert from 'node:assert/strict';
import {execFileSync, spawn, spawnSync} from 'node:child_process';
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ansiwiseRun} from './ansiwise-run.mjs';
import {CANARY, MODULE, PRODUCER_SUITES, RECORD, REFUSED, program, refuseSites, rendered, root, writeProducer} from './forgejo-plane-access-fake.mjs';

const PRODUCERS = [
  'ansiwise/templates/forgejo-build-credentials.sh.tpl',
  'ansiwise/templates/forgejo-machine-user.sh.tpl',
  'ansiwise/templates/forgejo-ssh-host-key.sh.tpl',
  'ansiwise/templates/plane-sign-in.sh.tpl',
];
const sourceOf = template => readFileSync(new URL(template, root), 'utf8');

// Each expression a refusal formats, with why it holds nothing private.
const PUBLIC = {
  NAME: 'the producer\'s own name, a literal of its start() call',
  what: 'the description a caller of kube() writes from literals and the names below',
  name: 'the description a caller of object_json() writes from literals and the names below',
  namespace: 'a namespace literal of the producer',
  method: 'a literal HTTP verb',
  path: 'an API path built from literals, the row\'s user, repository and organisation names, a quoted token name and validated identifiers',
  'str(status)': 'the integer status Python\'s HTTP client answers',
  user: 'the row\'s user name',
  USER: 'the row\'s user name',
  TEAM: 'a literal team name',
  organisation: 'an organisation name of the row',
  "', '.join(missing)": 'the owners of the row\'s repositories',
  EMAIL: 'the row\'s user name and a literal domain',
  PLANE_EMAIL: 'the row\'s user name and a literal domain',
  PLANE_LABEL: 'a literal key label',
  KEY_TYPE: 'a literal key type',
  'str(len(lines))': 'a count',
  workspace: 'a workspace slug plane_targets() matches against [a-z0-9][a-z0-9_-]*',
  project: 'a project UUID in its canonical form, from plane_targets()',
  place: '"workspace" or "project" and the two names above',
  'str(statuses[project])': 'a status validated as an integer from 100 to 599 before it is formatted',
};

const unaudited = source => {
  const {sites, described} = refuseSites(source);
  return [...new Set([...sites.flatMap(site => site.leaves ?? ['<not one positional argument>']), ...described])]
    .filter(expression => !(expression in PUBLIC));
};

// Every call that starts a process must capture both of its streams: a child that inherits stderr could
// write a marked line of its own.
const UNCAPTURED = `import ast, json, re, sys
text = sys.stdin.read()
found = re.search(r"<<'PY'\\n(.*?)\\nPY\\n", text, re.S)
tree = ast.parse(found.group(1) if found else text)
starts = {'run', 'Popen', 'call', 'check_call', 'check_output', 'system', 'popen', 'spawn', 'execv', 'execve', 'execvp'}
calls = [n for n in ast.walk(tree) if isinstance(n, ast.Call) and isinstance(n.func, ast.Attribute) and n.func.attr in starts
         and isinstance(n.func.value, ast.Name) and n.func.value.id in ('subprocess', 'os')]
print(json.dumps({'calls': len(calls), 'uncaptured': [n.lineno for n in calls if not any(
    k.arg == 'capture_output' and isinstance(k.value, ast.Constant) and k.value.value is True for k in n.keywords)]}))`;
const processStarts = source => JSON.parse(execFileSync('python3', ['-I', '-c', UNCAPTURED], {input: source, encoding: 'utf8'}));

const census = () => Object.fromEntries([MODULE, ...PRODUCERS].map(template => [template, refuseSites(sourceOf(template))]));
const siteIds = byTemplate => Object.entries(byTemplate).flatMap(([template, {sites}]) => sites.map((_, index) => `${template}#${index}`));

test('the census finds every refuse() of the module and the four producers in their sources, none raised elsewhere', () => {
  const found = census();
  assert.deepEqual(Object.fromEntries(Object.entries(found).map(([template, {sites}]) => [template.split('/').pop(), sites.length])), {
    'forgejo-plane-access.py.tpl': 29, 'forgejo-build-credentials.sh.tpl': 16, 'forgejo-machine-user.sh.tpl': 10,
    'forgejo-ssh-host-key.sh.tpl': 7, 'plane-sign-in.sh.tpl': 21,
  }, 'a refuse() was added or removed: this table is the reviewed census, so change it with the fixture that reaches the site');
  assert.equal(found[MODULE].raised, 1, 'only refuse() itself raises Refused');
  for (const template of PRODUCERS) assert.equal(found[template].raised, 0, template + ' raises Refused itself');
  // PLANTED INNOCENT: one more site in a copy of the source is counted at once.
  assert.equal(refuseSites(sourceOf(MODULE) + "\ndef planted():\n    refuse('planted')\n").sites.length, 30);
});

test('a refusal formats only literals, the row\'s own names, validated identifiers and integer statuses', () => {
  for (const template of [MODULE, ...PRODUCERS]) assert.deepEqual(unaudited(sourceOf(template)), [], template);
  // PLANTED DEFECTS: a credential, a response body, a command's output and a raw field of an answer in a reason.
  for (const planted of ["refuse('bad ' + token)", "refuse('bad ' + str(error))", "refuse('bad ' + result.stderr)", "refuse('bad ' + answer['error'])",
    "refuse(f'bad {entry}')", "refuse('bad ' + second[0])", "refuse('bad %s' % token)", "refuse(message)"]) {
    assert.notDeepEqual(unaudited(planted), [], planted);
  }
  assert.notDeepEqual(unaudited("kube(['get'], what='the ' + token)"), []);
  assert.notDeepEqual(unaudited("object_json(text, 'the ' + token)"), []);
  // PLANTED INNOCENT: the names and literals the producers use.
  assert.deepEqual(unaudited("refuse(USER + ' is not an active user; HTTP ' + str(status))"), []);
});

test('every process a producer or the module starts has both of its streams captured', () => {
  for (const template of [MODULE, ...PRODUCERS]) {
    const {calls, uncaptured} = processStarts(sourceOf(template));
    assert.deepEqual(uncaptured, [], template);
    assert.ok(calls > 0 || template !== MODULE, 'the module starts its cluster commands');
  }
  // PLANTED DEFECT: a child that inherits stderr; PLANTED INNOCENT: a captured one.
  assert.deepEqual(processStarts("subprocess.run(['x'], input='')").uncaptured, [1]);
  assert.deepEqual(processStarts("subprocess.run(['x'], input='', capture_output=True)").uncaptured, []);
});

// finish() under the shared module with an exchange of the test's writing, as the engine invokes a producer.
async function finishing(exchange, {mode = '--apply', setup = '', arguments: given} = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-plane-access-finish-'));
  try {
    const module = join(directory, 'forgejo-plane-access.py');
    await writeFile(module, rendered(sourceOf(MODULE)));
    const kubectl = join(directory, 'kubectl');
    await writeFile(kubectl, `#!/usr/bin/env bash\necho 'refused: ${CANARY}-child' >&2\necho '${CANARY}-child-out'\nexit 1\n`, {mode: 0o700});
    const driver = `import importlib.util, sys
spec = importlib.util.spec_from_file_location('forgejo_plane_access', ${JSON.stringify(module)})
access = importlib.util.module_from_spec(spec)
spec.loader.exec_module(access)
access.start('Fixture producer', 'ns', 'sel', 'ctr')
${setup}
def exchange():
${exchange.split('\n').map(line => '    ' + line).join('\n')}
access.finish(exchange)
`;
    const result = spawnSync('python3', ['-I', '-B', '-c', driver, ...(given ?? [mode, '--', kubectl])], {encoding: 'utf8', input: ''});
    return {code: result.status, stdout: result.stdout, stderr: result.stderr};
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test('a plain reason leaves as the one marked line, and the run fails with nothing on stdout', async () => {
  for (const mode of ['--check', '--apply']) {
    const run = await finishing("access.refuse('Forgejo said no for user alice, HTTP 403')", {mode});
    assert.deepEqual([run.code, run.stdout, run.stderr], [1, '', REFUSED + 'Forgejo said no for user alice, HTTP 403\n']);
  }
  // PLANTED INNOCENT: a reason that holds the marker text itself is still one line, marked once at its start.
  const inside = await finishing("access.refuse('refused: twice')");
  assert.deepEqual([inside.code, inside.stderr], [1, REFUSED + 'refused: twice\n']);
});

test('a reason that is not one plain line takes a fixed unmarked failure that quotes none of it', async () => {
  const shapes = {
    'a line feed': '\\n', 'a carriage return': '\\r', 'a null': '\\x00', 'an escape': '\\x1b[31m', 'a delete': '\\x7f', 'a tab': '\\t',
    'a next line': '\\x85', 'a line separator': '\\u2028', 'a paragraph separator': '\\u2029', 'a vertical tab': '\\x0b', 'a form feed': '\\x0c',
    'a letter beyond ASCII': '\\u00e9', 'a bidirectional mark': '\\u202e', 'a zero width space': '\\u200b',
  };
  for (const [name, character] of Object.entries(shapes)) {
    for (const placement of [`'a ${CANARY}' + '${character}' + 'b'`, `'${character}' + '${CANARY}'`, `'${CANARY}' + '${character}'`]) {
      const run = await finishing(`access.refuse(${placement})`);
      assert.deepEqual([run.code, run.stdout], [1, ''], name);
      assert.equal(run.stderr, 'Fixture producer refused for a reason that is not one plain line; reason withheld\n', name);
    }
  }
  for (const empty of ["''", "'   '"]) {
    const run = await finishing(`access.refuse(${empty})`);
    assert.equal(run.stderr, 'Fixture producer refused for a reason that is not one plain line; reason withheld\n', empty);
  }
});

test('nothing but a refusal is marked: an exception, a cancellation of its own, a failed child and a success are not', async () => {
  const exception = await finishing(`raise ValueError(${JSON.stringify(CANARY)})`);
  assert.deepEqual([exception.code, exception.stdout, exception.stderr], [1, '', 'Fixture producer could not complete; exception details withheld\n']);
  // A cluster command that prints a marked line of its own on the stream it inherits; the module captures it.
  const child = await finishing("access.kube(['get', 'pods'])");
  assert.deepEqual([child.code, child.stdout, child.stderr], [1, '', REFUSED + 'the Forgejo pod command was refused; output withheld\n']);
  assert.ok(!child.stderr.includes(CANARY), 'the child\'s marked line reached stderr');
  const done = await finishing("return {'satisfied': True}");
  assert.deepEqual([done.code, done.stdout, done.stderr], [0, '{"satisfied": true}\n', '']);
  // An uncaught Refused, outside finish(), prints with a capital R and is no marker.
  const uncaught = await finishing('pass', {setup: "raise access.Refused('outside finish')"});
  assert.notEqual(uncaught.code, 0);
  assert.ok(!uncaught.stderr.split('\n').some(line => line.startsWith(REFUSED)), uncaught.stderr);
  // A producer that exits itself, as start() does for a bad invocation, says it unmarked.
  const bad = await finishing('pass', {arguments: []});
  assert.deepEqual([bad.code, bad.stderr], [1, 'Fixture producer expects --check or --apply and the cluster invocation\n']);
});

// The refuse() sites no fault fixture reaches yet, by their number in their template's census. Each is audited above
// (its message formats only literals and the audited names) but not run. A new site is red until a fixture reaches it,
// and a site a fixture now reaches is red until it leaves this list, so the list can only shrink.
const GAPS = [
  [MODULE, [1, 2, 4, 5, 8, 10, 12, 13, 14, 15, 16, 19, 23, 24, 25, 28]],
  ['ansiwise/templates/forgejo-build-credentials.sh.tpl', [6, 9, 10, 11, 15]],
  ['ansiwise/templates/forgejo-machine-user.sh.tpl', [4, 5]],
  ['ansiwise/templates/plane-sign-in.sh.tpl', [1, 6, 18, 19, 20]],
].flatMap(([template, numbers]) => numbers.map(number => `${template}#${number}`));

// The four producer suites under the recorder: each shipped producer and module appends the refuse() it runs.
const outputOf = child => new Promise((resolve, reject) => {
  let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d);
  child.on('error', reject); child.on('close', code => resolve({code, output}));
});

test('every refuse() of the census but the listed gaps is reached by a fault fixture of the four producer suites', {timeout: 900_000}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-refusal-record-'));
  const record = join(directory, 'record.jsonl');
  try {
    writeFileSync(record, '');
    const runs = await Promise.all(PRODUCER_SUITES.map(name => outputOf(spawn('node', [fileURLToPath(new URL(`scripts/${name}.test.mjs`, root))], {
      env: {...process.env, NODE_TEST_CONTEXT: undefined, [RECORD]: record}, stdio: ['ignore', 'pipe', 'pipe']})).then(run => ({name, ...run}))));
    for (const run of runs) assert.equal(run.code, 0, `${run.name} failed under the recorder:\n${run.output.split('\n').slice(-60).join('\n')}`);
    const recorded = readFileSync(record, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
    assert.ok(recorded.length > 0, 'the recorder wrote nothing, so no site was seen');
    assert.deepEqual(recorded.filter(([site]) => site === null).map(([, scope, line, message]) => `${scope}:${line} ${message}`), [],
      'a refusal came from a line no census site holds');
    const reached = new Set(recorded.map(([site]) => site)), all = siteIds(census());
    const missing = all.filter(site => !reached.has(site));
    console.log(`refusal census: ${all.length - missing.length} of ${all.length} refuse() sites exercised`);
    assert.deepEqual(missing, GAPS, `${missing.length} refuse() sites no fault fixture reaches, against ${GAPS.length} known gaps`);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});


// THE REAL CLI. The pinned ansiwise-cli runs the shipped row of each producer family against a fake Vault, which
// runs in a process of its own because the helper that starts the CLI blocks this one while it runs, and a
// cluster whose kubectl refuses. The producers are the rendered templates, the module is the rendered module.
const VAULT = `import {createServer} from 'node:http';
import {appendFileSync} from 'node:fs';
createServer((request, response) => {
  request.resume();
  request.on('end', () => {
    appendFileSync(process.argv[1], request.method + ' ' + request.url + '\\n');
    response.writeHead(request.method === 'GET' ? 404 : 200, {'content-type': 'application/json'});
    response.end(request.method === 'GET' ? '{"errors":[]}' : '{"data":{"version":1}}');
  });
}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });`;
const ROOT_TOKEN = 'fixture-vault-root-token-9c1d';
// The six shipped credential rows, each with the template it renders and the first refusal it makes against a cluster
// whose kubectl refuses (the plane row, which reads a file of people first, against a file that is absent).
const POD_REFUSED = 'the Forgejo pod command was refused; output withheld';
const MACHINE = 'ansiwise/templates/forgejo-machine-user.sh.tpl';
const FAMILIES = {
  'forgejo-build-credentials': {template: 'ansiwise/templates/forgejo-build-credentials.sh.tpl', producer: '/run/forgejo-build-credentials.sh', reason: 'the Pipeline forgejo-release was refused; output withheld'},
  'forgejo-machine-user-argocd': {template: MACHINE, producer: '/run/forgejo-machine-user-argocd.sh', reason: POD_REFUSED},
  'forgejo-machine-user-hostyour-cloud-bump': {template: MACHINE, producer: '/run/forgejo-machine-user-hostyour-cloud-bump.sh', reason: POD_REFUSED},
  'forgejo-machine-user-deploy-bump': {template: MACHINE, producer: '/run/forgejo-machine-user-deploy-bump.sh', reason: POD_REFUSED},
  'forgejo-ssh-host-key': {template: 'ansiwise/templates/forgejo-ssh-host-key.sh.tpl', producer: '/run/forgejo-ssh-host-key.sh', reason: POD_REFUSED},
  'plane-sign-in': {template: 'ansiwise/templates/plane-sign-in.sh.tpl', producer: '/run/plane-sign-in.sh', reason: 'the further people of Plane could not be read; Plane sign-in was not changed'},
};

const rowOf = ({producer}) => {
  const rows = program.steps.filter(step => step.step === 'vault_kv_entry_from_command' && step.producer === producer);
  assert.equal(rows.length, 1, producer + ' has one shipped credential row');
  return rows[0];
};
const renderRow = ({template, producer}) => program.steps.find(step => step.template === template && step.path === producer && Object.hasOwn(step, 'values'));

// Starts the fake Vault; `stop()` ends it and `writes()` names every request that was not a read.
async function startVault(directory) {
  const log = join(directory, 'vault.log');
  writeFileSync(log, '');
  const child = spawn(process.execPath, ['--input-type=module', '-e', VAULT, log], {stdio: ['ignore', 'pipe', 'inherit']});
  const port = await new Promise((resolve, reject) => {
    child.stdout.once('data', data => resolve(Number(data.toString().trim())));
    child.on('error', reject);
  });
  return {port, stop: () => child.kill(), writes: () => readFileSync(log, 'utf8').split('\n').filter(line => line && !line.startsWith('GET '))};
}

/** One producer family run by the real CLI: its rendered producer, a kubectl of `kubectl` (a Bash script body), and
 * a Vault checkout and credentials file. Returns what `modes` produced last, and the Vault's writes. */
async function runFamily(name, {kubectl, modes, mutate, mutateModule, producerText}) {
  const family = FAMILIES[name];
  const directory = await mkdtemp(join(tmpdir(), 'forgejo-real-cli-'));
  const vault = await startVault(directory);
  try {
    const values = Object.fromEntries(Object.entries(renderRow(family)?.values ?? {}).map(([slot, source]) =>
      [slot, typeof source === 'string' ? source : slot.endsWith('organisations') ? 'fixture' : /repositor(y|ies)$/.test(slot) ? 'fixture/repository' : `fixture-${slot}`]));
    const files = Object.fromEntries(['plane-further-people-file', 'authentik-token-file'].filter(slot => sourceOf(family.template).includes(`<${slot}>`))
      .map(slot => [slot, join(directory, 'absent-' + slot)]));
    const {producer} = await writeProducer(directory, family.template, {...values, ...files}, {mutate, mutateModule, port: 1});
    if (producerText) await writeFile(producer, producerText(await readFile(producer, 'utf8')));
    const script = join(directory, 'cluster-kubectl');
    await writeFile(script, `#!/usr/bin/env bash\n${kubectl}\n`, {mode: 0o700});
    mkdirSync(join(directory, 'checkout/clusters/active'), {recursive: true});
    mkdirSync(join(directory, 'checkout/secrets'));
    writeFileSync(join(directory, 'checkout/clusters/active/fixture.invalid.yaml'), `global:\n  endpoints:\n    vault:\n      url: http://127.0.0.1:${vault.port}\n`);
    writeFileSync(join(directory, 'checkout/secrets/vault-test.txt'), `Root Token: ${ROOT_TOKEN}\n`);
    const row = {...rowOf(family), repository: join(directory, 'checkout'), producer, kubectl: [script], kubectl_needs_root: false};
    delete row.when;
    const layout = ['profile_path', 'domain_answer', 'vault_url_key', 'idp_url_key', 'cluster_name_key', 'kubernetes_auth_path_key', 'credentials_path', 'run_answer'];
    const definition = {name: 'refusal-fixture', roles: ['master'], defaults: Object.fromEntries(layout.map(key => [key, program.defaults[key]])),
      answers: program.answers.filter(answer => ['fqdn', 'stage'].includes(answer.name)), steps: [row]};
    const result = ansiwiseRun({definition, config: fileURLToPath(new URL('ansiwise.yaml', root)), modes, answers: {fqdn: 'fixture.invalid', stage: 'test'}});
    return {...result, vaultWrites: vault.writes(), directory};
  } finally {
    vault.stop();
    await rm(directory, {recursive: true, force: true});
  }
}
const FAILING_KUBECTL = `echo '${CANARY}-kubectl-stdout'; echo 'refused: ${CANARY}-kubectl-stderr' >&2; exit 1`;

// What the record and the output of a run hold, as one text: a secret may be in none of it.
const recordOf = run => run.output + JSON.stringify(run.events);
function assertUndisclosed(run, secrets) {
  for (const secret of secrets) assert.ok(!recordOf(run).includes(secret), 'the record of the run holds a secret that no one registered');
}
const CHILD = [`${CANARY}-kubectl-stdout`, `${CANARY}-kubectl-stderr`];
const finished = run => run.events.filter(event => event.kind === 'step-finished').at(-1)?.verdict;
const logged = run => run.events.filter(event => event.kind === 'log').map(event => event.message);
const REFUSAL = reason => `the credential producer refused with exit 1: ${reason}`;
const GENERIC = 'the credential producer check failed with exit 1';

test('REAL CLI: each of the six shipped rows shows its refusal reason in the record, declared in test and dry and failed in run, and nothing else', async () => {
  for (const [name, {reason}] of Object.entries(FAMILIES)) {
    for (const mode of ['test', 'dry']) {
      const declared = await runFamily(name, {kubectl: FAILING_KUBECTL, modes: [mode]});
      assert.equal(declared.code, 0, `${name} ${mode}: ${declared.output}`);
      assert.deepEqual(logged(declared), [`not answered before the steps it rests on have run: ${REFUSAL(reason)}`], `${name} ${mode}`);
      assert.deepEqual(declared.vaultWrites, []);
      assertUndisclosed(declared, CHILD);
    }
    const failed = await runFamily(name, {kubectl: FAILING_KUBECTL, modes: ['dry', 'run']});
    assert.equal(failed.code, 1, `${name} run: ${failed.output}`);
    assert.deepEqual(finished(failed), {label: 'exit', reason: REFUSAL(reason)}, name);
    const withheld = failed.events.find(event => event.kind === 'command-finished');
    assert.deepEqual([withheld.exit_code, withheld.stdout_lines, withheld.stderr_lines > 0], [1, 0, true], 'the raw stderr is counted, not shown');
    assert.deepEqual(failed.vaultWrites, [], 'a refusal writes no Vault entry');
    assertUndisclosed(failed, CHILD);
  }
});

// A cluster whose kubectl answers one ready pod and serves the Forgejo SSH host key file once as a key, then as two lines.
const RSA_KEY = 'ssh-rsa ' + Buffer.concat([Buffer.from([0, 0, 0, 7]), Buffer.from('ssh-rsa'), Buffer.from('fixture')]).toString('base64');
const SERVING = (valid, then = `${valid}\\nssh-rsa AAAA`) => `COUNT="$(dirname "$0")/count"
case "$*" in
  *'get pods'*) echo '{"items":[{"metadata":{"name":"fixture-pod"},"status":{"podIP":"127.0.0.1","conditions":[{"type":"Ready","status":"True"}]}}]}' ;;
  *'cat /data/ssh/gitea.rsa.pub'*)
    n=$(($(cat "$COUNT" 2>/dev/null || echo 0) + 1)); echo "$n" > "$COUNT"
    if [ "$n" -lt 3 ]; then echo '${valid}'; else printf '${then}\\n'; fi ;;
  *) exit 1 ;;
esac`;

test('REAL CLI: an apply that refuses shows its reason in the run record, and the entry is not written', async () => {
  const run = await runFamily('forgejo-ssh-host-key', {kubectl: SERVING(RSA_KEY), modes: ['dry', 'run']});
  assert.equal(run.code, 1, run.output);
  assert.deepEqual(finished(run), {label: 'exit', reason: REFUSAL('the Forgejo SSH host key file holds 2 lines; exactly one ssh-rsa line is expected')});
  assert.deepEqual(run.events.filter(event => event.kind === 'command-finished').map(event => event.exit_code), [0, 1], 'the check was ready and the apply refused');
  assert.deepEqual(run.vaultWrites, []);
});

test('REAL CLI: a failure that marks no line stays withheld and shows no text of its output', async () => {
  const secretStreams = `echo '${CANARY}-stdout'; echo '${CANARY}-stderr' >&2; `;
  const planted = {
    'no marker': `${secretStreams}exit 1`,
    'an empty reason': `${secretStreams}echo 'refused: ' >&2; exit 1`,
    'an indented marker': `${secretStreams}echo '  refused: ${CANARY}-indented' >&2; exit 1`,
    'an embedded marker': `${secretStreams}echo 'x refused: ${CANARY}-embedded' >&2; exit 1`,
    'a marker on stdout': `echo 'refused: ${CANARY}-stdout-marker'; echo '${CANARY}-stderr' >&2; exit 1`,
    'a capital R': `${secretStreams}echo 'Refused: ${CANARY}-capital' >&2; exit 1`,
    'a generic exception': `${secretStreams}python3 -c "raise ValueError('${CANARY}-exception')"`,
  };
  for (const [name, body] of Object.entries(planted)) {
    const run = await runFamily('forgejo-ssh-host-key', {kubectl: FAILING_KUBECTL, modes: ['dry', 'run'],
      producerText: () => `#!/usr/bin/env bash\n${body}\n`});
    assert.equal(run.code, 1, `${name}: ${run.output}`);
    assert.deepEqual(finished(run), {label: 'exit', reason: GENERIC}, name);
    assert.deepEqual(run.vaultWrites, []);
    assertUndisclosed(run, [CANARY]);
  }
  // The real producer with its module gone: a load failure is no refusal, so it is withheld too.
  const absent = await runFamily('forgejo-ssh-host-key', {kubectl: FAILING_KUBECTL, modes: ['dry', 'run'],
    producerText: text => text.replace(/\S*forgejo-plane-access\.py/, '/absent/module.py')});
  assert.deepEqual(finished(absent), {label: 'exit', reason: GENERIC});
  assertUndisclosed(absent, ['module could not be loaded']);
  // A producer that outlives the module's own deadline refuses by name: that reason is the module's, marked, and shown.
  const late = await runFamily('forgejo-ssh-host-key', {kubectl: FAILING_KUBECTL, modes: ['dry', 'run'],
    mutateModule: text => text.replace('DEADLINE = time.monotonic() + 85', 'DEADLINE = time.monotonic() - 1')});
  assert.deepEqual(finished(late), {label: 'exit', reason: REFUSAL('Forgejo SSH host key exceeded its deadline')});
});

test('REAL CLI: a planted producer that marks a freshly issued secret is caught by the assertion that guards every refusal', async () => {
  const issued = 'ssh-ed25519 ' + CANARY + '-freshly-issued';
  const leaking = text => text.replace("refuse('the Forgejo SSH host key file holds no single ' + KEY_TYPE + ' key line')",
    "refuse('the Forgejo SSH host key file holds no single ' + KEY_TYPE + ' key line: ' + lines[0])");
  assert.notEqual(leaking(sourceOf('ansiwise/templates/forgejo-ssh-host-key.sh.tpl')), sourceOf('ansiwise/templates/forgejo-ssh-host-key.sh.tpl'), 'the plant applies');
  const plant = await runFamily('forgejo-ssh-host-key', {kubectl: SERVING(issued, issued), modes: ['dry', 'run'], mutate: leaking});
  assert.equal(plant.code, 1, plant.output);
  assert.ok(finished(plant).reason.includes(CANARY), 'the canary reached the marked reason');
  assert.throws(() => assertUndisclosed(plant, [CANARY]), /holds a secret/);
  // PLANTED INNOCENT: the shipped producer refuses the same file with a public reason, and the same assertion holds.
  const shipped = await runFamily('forgejo-ssh-host-key', {kubectl: SERVING(issued, issued), modes: ['dry', 'run']});
  assert.deepEqual(finished(shipped), {label: 'exit', reason: REFUSAL('the Forgejo SSH host key file holds no single ssh-rsa key line')});
  assertUndisclosed(shipped, [CANARY]);
});
