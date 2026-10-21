// The parts of the fake cluster both credential producer tests drive: the engine's template rule,
// a kubectl that hands its argv and its whole stdin to the test's server, the Forgejo pod and its
// user CLI, and the framing of an answer of Plane's API pod.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export const root = new URL('../', import.meta.url);
export const MARK = 'forgejo-plane-access answer ';
export const MODULE = 'ansiwise/templates/forgejo-plane-access.py.tpl';
export const REFUSED = 'refused: ';
// The suites that run a rendered producer under the fake cluster; the census suite runs each with RECORD set.
export const PRODUCER_SUITES = ['forgejo-build-credentials', 'forgejo-machine-user', 'forgejo-ssh-host-key', 'plane-sign-in'];
export const RECORD = 'FORGEJO_REFUSAL_RECORD';

// Every refuse() call of a producer's Python, in the order of the text, with the expressions its message
// formats, and the expressions of the descriptions the module's helpers put in a refusal (`what`, the name of
// object_json). A producer's Python is the heredoc of its template; the module is the whole file. A Refused
// raised anywhere but in refuse() itself would carry a reason no census site stands behind.
const CENSUS = `import ast, json, re, sys
text = sys.stdin.read()
found = re.search(r"<<'PY'\\n(.*?)\\nPY\\n", text, re.S)
tree = ast.parse(found.group(1) if found else text)
def leaves(n):
    if isinstance(n, ast.Constant): return []
    if isinstance(n, ast.BinOp) and isinstance(n.op, ast.Add): return leaves(n.left) + leaves(n.right)
    if isinstance(n, ast.IfExp): return leaves(n.body) + leaves(n.orelse)
    if isinstance(n, ast.JoinedStr): return [l for v in n.values for l in leaves(v)]
    if isinstance(n, ast.FormattedValue): return [ast.unparse(n.value)]
    return [ast.unparse(n)]
calls = [(n.lineno, n.col_offset, n, n.func.id if isinstance(n.func, ast.Name) else getattr(n.func, 'attr', None))
         for n in ast.walk(tree) if isinstance(n, ast.Call)]
calls.sort(key=lambda c: c[:2])
print(json.dumps({
    'sites': [{'line': n.lineno, 'end': n.end_lineno, 'leaves': leaves(n.args[0]) if len(n.args) == 1 and not n.keywords else None}
              for _, _, n, name in calls if name == 'refuse'],
    'raised': sum(1 for _, _, _, name in calls if name == 'Refused'),
    'described': [leaf for _, _, n, name in calls for expression in
                  ([n.args[1]] if name == 'object_json' and len(n.args) == 2 else []) + [k.value for k in n.keywords if k.arg == 'what']
                  for leaf in leaves(expression)],
}))`;

export const refuseSites = source => JSON.parse(execFileSync('python3', ['-I', '-c', CENSUS], {input: source, encoding: 'utf8'}));

const yaml = file => JSON.parse(execFileSync('yq', ['-o=json', '.', new URL(file, root).pathname], {encoding: 'utf8'}));
export const program = yaml('ansiwise/programs/deploy-platform-services.yaml');
export const installation = yaml('ansiwise.yaml');

// The engine's template rule (ansiwise-core lib/src/steps/slots.dart slotPattern, template.dart
// filledWith): every required slot names a value of the row, every value has a slot, and a line
// whose optional slot the row leaves out is dropped whole.
export function rendered(text, values = {}) {
  const slots = [...text.matchAll(/<([a-z][a-z0-9-]*)(!\?|\??)>/g)];
  const unfilled = slots.filter(([, name, suffix]) => suffix === '' && !(name in values)).map(([slot]) => slot);
  const unplaced = Object.keys(values).filter(name => !slots.some(([, slot]) => slot === name));
  if (slots.some(([, , suffix]) => suffix === '!?')) throw new Error('this fixture renders no carried slot');
  if (unfilled.length || unplaced.length) throw new Error(`template and values do not fit: unfilled ${unfilled}, unplaced ${unplaced}`);
  return text.split('\n').filter(line => [...line.matchAll(/<([a-z][a-z0-9-]*)\?>/g)].every(([, name]) => name in values))
    .join('\n').replace(/<([a-z][a-z0-9-]*)\??>/g, (_, name) => values[name]);
}

// With RECORD naming a file, a shipped producer and module (no mutation) append each refuse() they run to it as
// [site, scope, line, message]: the site is the call's number in its template's census, found by the line of the call.
function recordingRefusals(module, producer, template, file) {
  const table = (source, name) => refuseSites(source).sites.map((site, index) => [site.line, site.end, `${name}#${index}`]);
  const moduleSites = refuseSites(module).sites;
  assert.ok(moduleSites.length > 0 && refuseSites(producer).sites.length > 0, 'the census found no refuse()');
  const hook = '    raise Refused(message)\n';
  assert.equal(module.split(hook).length, 2, 'refuse() raises in one place');
  return module.replace(hook, '    _record_refusal(message); raise Refused(message)\n') + `

REFUSAL_SITES = ${JSON.stringify({module: table(module, MODULE), producer: table(producer, template)})}


def _record_refusal(message):
    frame = sys._getframe(2)
    scope = 'producer' if frame.f_globals.get('__name__') == '__main__' else 'module'
    site = next((s for first, last, s in REFUSAL_SITES[scope] if first <= frame.f_lineno <= last), None)
    with open(${JSON.stringify(file)}, 'a') as record:
        record.write(json.dumps([site, scope, frame.f_lineno, message]) + chr(10))
`;
}

/** Writes the module and the producer of `template` into `directory`, rendered with the row's values,
 * the module path pointing at the copy there and, where the template has the slot, the lock beside it. */
export async function writeProducer(directory, template, values, {mutate, mutateModule, port} = {}) {
  const module = join(directory, 'forgejo-plane-access.py');
  const producer = join(directory, 'producer.sh');
  const text = (mutate ?? (t => t))(await readFile(new URL(template, root), 'utf8'));
  const locked = text.includes('<forgejo-credential-lock>') ? {'forgejo-credential-lock': join(directory, 'credentials.lock')} : {};
  const script = rendered(text, {...values, 'forgejo-plane-access-module': module, ...locked});
  let accessText = rendered((mutateModule ?? (t => t))(await readFile(new URL(MODULE, root), 'utf8')))
    .replace('PORT = 3000', 'PORT = ' + port).replace('POD_WAIT_SECONDS = 30', 'POD_WAIT_SECONDS = 0.1');
  if (process.env[RECORD] && !mutate && !mutateModule) accessText = recordingRefusals(accessText, script, template, process.env[RECORD]);
  await writeFile(module, accessText, {mode: 0o600});
  await writeFile(producer, script);
  const kubectl = join(directory, 'kubectl');
  await writeFile(kubectl, `#!/usr/bin/env node
let stdin = ''; for await (const chunk of process.stdin) stdin += chunk;
const r = await fetch('http://127.0.0.1:${port}/_command', {method: 'POST', body: JSON.stringify({argv: process.argv.slice(2), stdin})});
process.stdout.write(await r.text()); process.exit(r.status === 200 ? 0 : 1);
`, {mode: 0o700});
  return {producer, kubectl};
}

// No test runs a snippet in Django, so each one sent must at least compile and read no name that
// neither it, its prelude nor Python's builtins define.
const SNIPPET_CHECK = `import builtins, symtable, sys
top = symtable.symtable(sys.stdin.read(), 'snippet', 'exec')
defined = {s.get_name() for s in top.get_symbols() if s.is_assigned() or s.is_imported()} | set(dir(builtins))
def undefined(table):
    for s in table.get_symbols():
        if s.is_referenced() and (table is top or s.is_global()) and s.get_name() not in defined:
            yield s.get_name()
    for child in table.get_children():
        yield from undefined(child)
names = sorted(set(undefined(top)))
if names:
    sys.exit('the snippet reads undefined names: ' + ', '.join(names))`;

/** The name line and the arguments of a Plane shell exec, or null for any other command; `error`
 * names what Django's shell would refuse the code for. */
export function planeExec(argv) {
  if (!argv.includes('manage.py')) return null;
  const code = argv.at(-1);
  const encoded = code.match(/b64decode\('([A-Za-z0-9+/=]*)'\)/)?.[1];
  assert.ok(encoded !== undefined, 'the snippet carries its arguments');
  let error = null;
  try {
    execFileSync('python3', ['-I', '-c', SNIPPET_CHECK], {input: code, stdio: ['pipe', 'pipe', 'pipe']});
  } catch (failure) {
    error = 'Traceback (most recent call last): ' + failure.stderr;
  }
  return {name: code.split('\n')[0], args: JSON.parse(Buffer.from(encoded, 'base64').toString()), error};
}

/** Plane's stdout around one answer: Django's count of imported objects unless the argv quiets it,
 * and the answer framed as the module reads it, absent, twice or followed by a log line. */
export function planeOutput(argv, value, framing = 'once') {
  const quiet = argv.includes('--no-imports') || argv[argv.indexOf('-v') + 1] === '0';
  const line = MARK + JSON.stringify(value) + '\n';
  return (quiet ? '' : '0 objects imported automatically (use -v 2 for details).\n') +
    {once: line, none: '', twice: line + line, log: line + '{"levelname": "INFO", "message": "request finished"}\n'}[framing];
}

/** Answers `get pods` and the Forgejo user list, create and delete from `users`, or returns null. */
export function forgejoCommand(argv, users, password, {unreadable = false, absentPod = false} = {}) {
  if (argv.includes('get') && argv.includes('pods')) {
    if (unreadable) return [500, 'unreadable'];
    return [200, {items: absentPod ? [] : [{metadata: {name: 'fixture-pod'}, status: {podIP: '127.0.0.1', conditions: [{type: 'Ready', status: 'True'}]}}]}];
  }
  const args = argv.slice(argv.indexOf('--') + 1);
  if (args.slice(0, 3).join(' ') !== 'forgejo admin user') return null;
  const name = args[args.indexOf('--username') + 1];
  switch (args[3]) {
    case 'list': return [200, 'ID Username Email IsActive IsAdmin 2FA\n' + [...users].map(([n, v], i) => `${i + 1} ${n} ${v.email} ${v.active} ${v.admin} false`).join('\n') + '\n'];
    case 'create':
      assert.ok(!args.includes('--password'), 'no password in arguments');
      assert.ok(args.includes('--random-password'));
      if (users.has(name)) return [500, 'already exists'];
      users.set(name, {email: args[args.indexOf('--email') + 1], admin: args.includes('--admin'), restricted: args.includes('--restricted'), active: true});
      return [200, `generated random password is '${password}'\nNew user created\n`];
    case 'delete': users.delete(name); return [200, ''];
    default: return null;
  }
}

/** What a failed producer left on its streams: nothing on stdout, no secret anywhere, and at most one marked
 * line, which is then the whole of stderr and one plain line of printable ASCII. Returns that reason, or null. */
export function failureReason({code, stdout, stderr}, secrets = []) {
  assert.notEqual(code, 0, 'the producer did not fail');
  assert.equal(stdout, '', 'a failed producer printed on stdout');
  for (const secret of secrets) assert.ok(!stderr.includes(secret), 'a failed producer disclosed a credential on stderr');
  const marked = stderr.split('\n').filter(line => line.startsWith(REFUSED));
  assert.ok(marked.length <= 1, 'a producer marked more than one line');
  if (marked.length === 0) return null;
  assert.match(stderr, /^refused: [ -~]*[!-~][ -~]*\n$/, 'a marked line is the whole of stderr, one plain line');
  return stderr.slice(REFUSED.length, -1);
}

/** `result` as it stands, once a failure of it has left nothing private: a producer's run helper settles with it. */
export function privateOutcome(result, secrets) {
  if (result.code !== 0) failureReason(result, secrets);
  return result;
}

/** The failure is a refusal whose reason is `reason`, a string or a pattern. */
export function assertRefused(result, reason, secrets = []) {
  const said = failureReason(result, secrets);
  assert.notEqual(said, null, 'the producer marked no reason; stderr: ' + result.stderr);
  if (typeof reason === 'string') assert.equal(said, reason); else assert.match(said, reason);
}

/** What a producer is handed that it cannot read: no JSON, JSON that is no object, and an entry that is no object.
 * Each holds `canary`, which no refusal may repeat. */
export const unreadableInputs = canary => [
  [/input is unreadable/, 'not json ' + canary],
  [/input is not an object/, '[' + JSON.stringify(canary) + ']'],
  [/entry is unreadable/, JSON.stringify({entry: canary, inputs: {}})],
];
export const CANARY = 'CANARY-not-a-registered-secret-7f3a';
