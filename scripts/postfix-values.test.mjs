import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';

// The mail relay refuses to start without ALLOWED_SENDER_DOMAINS and signs with DKIM for each domain it lists, so a
// template that loses the platform domain or the unit apex leaves the master's mail refused or unsigned. deploy-branch
// writes the values file from postfix-values.tpl; this suite fills the template the way write_file_from_template does
// (every <slot> from the `values:` entry of its name; a slot nothing fills and a value no slot takes are refused) and
// reads the allowlist back from the file that row would write.
const root = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATE = 'ansiwise/templates/postfix-values.tpl';
const PATH = '/srv/hostyour-cloud/installation/values/postfix.yaml';
const BINDINGS = {'platform-domain': {answer: 'platform_domain'}, 'unit-apex': {answer: 'unit_apex'}};
const DOMAINS = {
  platform_domain: {role: 'the platform domain', standIn: 'platform.relay.invalid'},
  unit_apex: {role: 'the unit apex', standIn: 'apex.relay.invalid'},
};
const yq = (args, input) => JSON.parse(execFileSync('yq', ['-o=json', ...args], {encoding: 'utf8', input}));
const steps = yq(['.steps', `${root}ansiwise/programs/deploy-branch.yaml`]);
const template = readFileSync(`${root}${TEMPLATE}`, 'utf8');

/** Every way the relay's allowlist misses the platform domain and the unit apex the branch row binds, named. */
function findings({steps, template}) {
  const found = [];
  const rows = steps.filter(row => row.step === 'write_file_from_template' && row.template === TEMPLATE);
  if (rows.length !== 1) found.push(`${rows.length} rows of deploy-branch write ${TEMPLATE}`);
  if (rows.length === 0) return found;
  const [row] = rows;
  if (row.path !== PATH) found.push(`the file is written to ${row.path}, not ${PATH}`);
  if (row.on_failure !== 'exit') found.push(`the row lets the run go on without the file (on_failure: ${row.on_failure})`);
  if (!isDeepStrictEqual(row.values, BINDINGS)) found.push(`the row binds ${JSON.stringify(row.values)}, not ${JSON.stringify(BINDINGS)}`);

  const slots = [...new Set([...template.matchAll(/<([a-z][a-z0-9-]*)>/g)].map(match => match[1]))];
  const bound = Object.keys(row.values ?? {});
  for (const slot of slots.filter(slot => !bound.includes(slot))) found.push(`the template has a slot <${slot}> the row does not fill`);
  for (const name of bound.filter(name => !slots.includes(name))) found.push(`the row binds ${name} and the template has no slot for it`);

  let rendered = template;
  for (const name of bound) rendered = rendered.replaceAll(`<${name}>`, DOMAINS[row.values[name]?.answer]?.standIn ?? `<${name}>`);
  const left = rendered.match(/<[^<>]*>/);
  if (left) found.push(`the file still holds ${left[0]} after the slots are filled`);

  let file;
  try {
    file = yq(['.'], rendered);
  } catch (error) {
    return [...found, `the file is not YAML: ${String(error.stderr ?? error.message).trim()}`];
  }
  const allowlist = file?.postfix?.config?.general?.ALLOWED_SENDER_DOMAINS;
  if (typeof allowlist !== 'string') return [...found, `postfix.config.general.ALLOWED_SENDER_DOMAINS is ${JSON.stringify(allowlist)}, not a string`];
  const named = allowlist.trim().split(/\s+/);
  for (const {role, standIn} of Object.values(DOMAINS)) {
    const times = named.filter(domain => domain === standIn).length;
    if (times !== 1) found.push(`ALLOWED_SENDER_DOMAINS names ${role} ${standIn} ${times} times, not once`);
  }
  for (const domain of named.filter(domain => !Object.values(DOMAINS).some(({standIn}) => standIn === domain))) {
    found.push(`ALLOWED_SENDER_DOMAINS names ${domain}, which is neither the platform domain nor the unit apex`);
  }
  return found;
}

test('the relay may send as the platform domain and the unit apex the branch row binds, and as nothing else', () => {
  assert.deepEqual(findings({steps, template}), []);
});

const rowOf = p => p.steps.find(row => row.template === TEMPLATE);
const replaced = (text, from, to) => {
  assert.ok(text.includes(from), `the planted defect cannot find ${JSON.stringify(from)} in the template`);
  return text.replace(from, to);
};
const PLANTED = {
  'the template without <unit-apex>': [p => { p.template = replaced(p.template, '<platform-domain> <unit-apex>', '<platform-domain>'); }, /unit apex apex\.relay\.invalid 0 times/],
  '<platform-domain> twice and no apex': [p => { p.template = replaced(p.template, '<unit-apex>', '<platform-domain>'); }, /unit apex apex\.relay\.invalid 0 times/],
  'a third literal domain': [p => { p.template = replaced(p.template, '<unit-apex>"', '<unit-apex> example.invalid"'); }, /names example\.invalid/],
  'the slot <unit-apex> renamed': [p => { p.template = replaced(p.template, '<unit-apex>', '<apex>'); }, /slot <apex> the row does not fill/],
  'the row without unit-apex': [p => { delete rowOf(p).values['unit-apex']; }, /slot <unit-apex> the row does not fill/],
  'the key moved to postfix.config': [p => { p.template = replaced(p.template, '    general:\n      ALLOWED', '    ALLOWED'); }, /postfix\.config\.general\.ALLOWED_SENDER_DOMAINS is undefined/],
  'a second row naming the template': [p => { p.steps.push(structuredClone(rowOf(p))); }, /2 rows of deploy-branch write/],
};
const INNOCENT = {
  'a comment line added to the template': p => { p.template = `# Added for the reader.\n${p.template}`; },
  'the two slots in the other order': p => { p.template = replaced(p.template, '<platform-domain> <unit-apex>', '<unit-apex> <platform-domain>'); },
  'another file_mode on the row': p => { rowOf(p).file_mode = 384; },
};

test('PLANTED DEFECT: each way the allowlist loses a domain is found, for its own reason', () => {
  for (const [name, [plant, reason]] of Object.entries(PLANTED)) {
    const planted = structuredClone({steps, template});
    plant(planted);
    assert.match(findings(planted).join('\n'), reason, name);
  }
});

test('PLANTED INNOCENT: what the allowlist does not care about stays green', () => {
  for (const [name, plant] of Object.entries(INNOCENT)) {
    const planted = structuredClone({steps, template});
    plant(planted);
    assert.deepEqual(findings(planted), [], name);
  }
});
