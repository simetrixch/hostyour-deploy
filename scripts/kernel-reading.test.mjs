import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The machine reads its own kernel because no pod can: mongod needs its rseq workaround on Linux
// 6.19 through 7.0.13, and the alert that says it is missing compares the pod with the version this
// script writes. These cases run the script of the template on signature files and judge the .prom
// it leaves, so a reading that is wrong never stands.
const root = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = 'ansiwise/templates/kernel-reading-script.tpl';
const SERVICE = 'ansiwise/templates/kernel-reading-service.tpl';
const script = readFileSync(`${root}${SCRIPT}`, 'utf8');
const READING = 'hostyour_kernel.prom';

const metric = (release, upstream) => `hostyour_kernel_info{release="${release}",upstream="${upstream}"} 1`;
const earlier = `# TYPE hostyour_kernel_info gauge\n${metric('6.8.0-45.45-generic', '6.8.12')}\n`;

/** Runs a copy of the script on a signature file (null: none stands) over a directory that may hold an earlier reading. */
function run(text, signature, before) {
  const work = mkdtempSync(join(tmpdir(), 'kernel-reading-'));
  try {
    const file = join(work, 'script.sh');
    const directory = join(work, 'textfile');
    mkdirSync(directory);
    writeFileSync(file, text);
    chmodSync(file, 0o755);
    if (signature !== null) writeFileSync(join(work, 'signature'), signature);
    if (before) writeFileSync(join(directory, READING), before);
    // Under a umask that hides the file from the pods' users, so the mode it is given is the script's own.
    const ran = spawnSync('sh', ['-c', 'umask 077; exec sh "$0" "$@"', file, join(work, 'signature'), directory], {encoding: 'utf8'});
    const files = readdirSync(directory, {withFileTypes: true}).map(entry => entry.name).sort();
    const reading = files.includes(READING) ? join(directory, READING) : null;
    return {
      status: ran.status,
      stderr: ran.stderr,
      files,
      content: reading && readFileSync(reading, 'utf8'),
      mode: reading && statSync(reading).mode & 0o777,
    };
  } finally {
    rmSync(work, {recursive: true, force: true});
  }
}

const GOOD = [
  ['a kernel in the affected range', 'Ubuntu 7.0.0-31.31-generic 7.0.13\n', '7.0.0-31.31-generic', '7.0.13'],
  ['the first kernel past it', 'Ubuntu 7.0.0-33.33-generic 7.0.14\n', '7.0.0-33.33-generic', '7.0.14'],
  ['a signature without its final newline', 'Ubuntu 7.0.0-31.31-generic 7.0.12', '7.0.0-31.31-generic', '7.0.12'],
];
const BAD = [
  ['an empty signature', ''],
  ['a signature of two fields', 'Ubuntu 7.0.0-31.31-generic\n'],
  ['a signature of four fields', 'Ubuntu 7.0.0-31.31-generic 7.0.14 extra\n'],
  ['an upstream of two numbers', 'Ubuntu 7.0.0-31.31-generic 7.0\n'],
  ['an upstream that is not a number', 'Ubuntu 7.0.0-31.31-generic 7.0.x\n'],
  ['a release a label cannot carry', 'Ubuntu 7.0.0"-generic 7.0.14\n'],
  ['no signature file at all', null],
];

/** Every way the script writes a wrong reading or leaves one standing, named. */
function findings(text) {
  const found = [];
  for (const [what, signature, release, upstream] of GOOD) {
    const out = run(text, signature);
    const expected = `${metric(release, upstream)}\n`;
    if (out.status !== 0) found.push(`${what} ends ${out.status}: ${out.stderr.trim()}`);
    else if (!out.content?.endsWith(expected)) found.push(`${what} writes ${JSON.stringify(out.content)}`);
    else if (out.files.length !== 1) found.push(`${what} leaves ${JSON.stringify(out.files)}`);
    else if (out.mode !== 0o644) found.push(`${what} writes a file of mode ${out.mode?.toString(8)}`);
  }
  const replaced = run(text, GOOD[1][1], earlier);
  if (replaced.content?.includes('6.8.12')) found.push('a new reading stands beside the earlier one');
  for (const [what, signature] of BAD) {
    const out = run(text, signature, earlier);
    if (out.status === 0) found.push(`${what} ends 0`);
    if (out.files.length !== 0) found.push(`${what} leaves ${JSON.stringify(out.files)} standing`);
    if (out.stderr.trim() === '') found.push(`${what} is refused without a word`);
  }
  return found;
}

test('a good signature is written as the metric, a bad one removes the earlier file and ends non-zero', () => {
  assert.deepEqual(findings(script), []);
});

/** A copy of the script with one text replaced; the replacement must change something. */
const plant = (from, to) => {
  assert.ok(script.includes(from), `the plant looks for ${from}, which the script does not hold`);
  return script.replace(from, to);
};

test('a copy that keeps the earlier file when the reading is bad is caught', () => {
  assert.notDeepEqual(findings(plant('  rm -f "$reading"\n', '  :\n')), []);
});

test('a copy that takes any upstream is caught', () => {
  assert.notDeepEqual(findings(plant("'^[0-9]+[.][0-9]+[.][0-9]+$'", "'^'")), []);
});

test('a copy that reads the release where the upstream stands is caught', () => {
  assert.notDeepEqual(findings(plant('read -r package release upstream extra', 'read -r package upstream release extra')), []);
});

test('a copy that leaves the file unreadable to the pods is caught', () => {
  assert.notDeepEqual(findings(plant('chmod 0644 "$partial"\n', '')), []);
});

test('the script without its comments is not told from the script', () => {
  const bare = script.split('\n').filter(line => !line.startsWith('#') || line.startsWith('#!')).join('\n');
  assert.deepEqual(findings(bare), []);
});

const steps = JSON.parse(execFileSync('yq', ['-o=json', '.steps', `${root}ansiwise/programs/deploy-host.yaml`], {encoding: 'utf8'}));
const row = match => steps.filter(match);

test('the service starts the script that deploy-host writes, over the directory it hands to the operator', () => {
  const [script_row] = row(r => r.step === 'write_file_from_template' && r.template === SCRIPT);
  const [service_row] = row(r => r.step === 'write_file_from_template' && r.template === SERVICE);
  const directories = row(r => r.step === 'hand_directory_to_account' && r.path === service_row?.values?.['textfile-directory']);
  assert.ok(script_row, 'no row writes the script');
  assert.ok(service_row, 'no row writes the service');
  assert.equal(service_row.values['script-path'], script_row.path);
  assert.equal(directories.length, 1, 'the directory the service writes into is handed to the operator by no row, or by two');
  assert.equal(directories[0].account_answer, 'operator_user');
  assert.deepEqual(service_row.values['operator-user'], {answer: 'operator_user'});
  const slots = new Set(readFileSync(`${root}${SERVICE}`, 'utf8').match(/<[a-z][a-z-]*>/g)?.map(slot => slot.slice(1, -1)));
  assert.deepEqual([...slots].sort(), Object.keys(service_row.values).sort());
});
