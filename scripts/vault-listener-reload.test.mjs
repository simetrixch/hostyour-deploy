import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The secret store's listener keeps the leaf it loaded until the server is sent SIGHUP, though its
// pair renews on disk with Secret platform-tls. deploy-platform-services installs a daily timer whose
// service sends that signal and nothing else, on the cluster that runs the store.
const root = fileURLToPath(new URL('..', import.meta.url));
const steps = JSON.parse(execFileSync('yq', ['-o=json', '.steps', `${root}ansiwise/programs/deploy-platform-services.yaml`], {encoding: 'utf8'}));
const SERVICE = 'ansiwise/templates/vault-reload-service.tpl';
const TIMER = 'ansiwise/templates/vault-reload-timer.tpl';
const templates = Object.fromEntries([SERVICE, TIMER].map(t => [t, readFileSync(`${root}${t}`, 'utf8')]));

const GATES = ['secret_store_enabled', 'books_here_in_answers'];
const UNIT = '/etc/systemd/system/hostyour-vault-reload';
const RELOAD = "/snap/bin/microk8s kubectl -n vault exec vault-0 -c vault -- sh -c 'kill -HUP $$(pgrep -o -x vault)'";

/** A unit file as {section: [[key, value]]}, comments and blank lines left out. */
const unit = text => {
  const sections = {};
  let current;
  for (const line of text.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
    const header = /^\[(.+)\]$/.exec(line);
    if (header) sections[current = header[1]] ??= [];
    else sections[current]?.push([line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]);
  }
  return sections;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every way the reload is missing or does more than reload, named. */
function findings({steps, templates}) {
  const found = [];
  const store = steps.findIndex(row => row.step === 'helm_release' && row.release === 'vault');
  const rows = {
    service: steps.flatMap((row, i) => row.step === 'write_file_from_template' && row.path === `${UNIT}.service` ? [i] : []),
    timer: steps.flatMap((row, i) => row.step === 'write_file_from_template' && row.path === `${UNIT}.timer` ? [i] : []),
    enabled: steps.flatMap((row, i) => row.step === 'enable_service' && row.unit === 'hostyour-vault-reload.timer' ? [i] : []),
  };
  for (const [name, at] of Object.entries(rows)) {
    if (at.length !== 1) found.push(`${at.length} rows write or enable the reload ${name}`);
    for (const i of at) {
      const row = steps[i];
      if (store < 0 || i < store) found.push(`the reload ${name} stands before the store's release`);
      if (!GATES.every(g => (row.when ?? []).includes(g))) found.push(`the reload ${name} runs under ${JSON.stringify(row.when)}`);
      if (row.on_failure !== 'exit') found.push(`the reload ${name} lets the run go on without it`);
    }
  }
  if (!(rows.service[0] < rows.timer[0] && rows.timer[0] < rows.enabled[0])) found.push('the reload rows are not service, timer, enable');
  const service = steps[rows.service[0]];
  if (service && (service.template !== SERVICE || !same(service.values, {'operator-user': {answer: 'operator_user'}}))) found.push(`the reload service is written from ${service.template} with ${JSON.stringify(service.values)}`);
  if (rows.timer.length === 1 && steps[rows.timer[0]].template !== TIMER) found.push(`the reload timer is written from ${steps[rows.timer[0]].template}`);

  const s = unit(templates[SERVICE] ?? '');
  if (!same(s.Service, [['Type', 'oneshot'], ['User', '<operator-user>'], ['TimeoutStartSec', '60s'], ['ExecStart', RELOAD]])) found.push(`the reload service does ${JSON.stringify(s.Service)}`);
  if (s.Install) found.push('the reload service is started by something other than its timer');
  const t = unit(templates[TIMER] ?? '');
  if (!same(t.Timer, [['OnCalendar', 'daily'], ['Persistent', 'true']])) found.push(`the reload timer fires on ${JSON.stringify(t.Timer)}`);
  if (!same(t.Install, [['WantedBy', 'timers.target']])) found.push('the reload timer is not armed at boot');
  return found;
}

test('the store is told daily to read its renewed pair, and nothing more', () => {
  assert.deepEqual(findings({steps, templates}), []);
});

const at = match => p => p.steps.findIndex(match);
const reloadService = at(r => r.path === `${UNIT}.service`);
const PLANTED = {
  'TERM for HUP': p => { p.templates[SERVICE] = p.templates[SERVICE].replace('kill -HUP', 'kill -TERM'); },
  'the timer not enabled': p => { p.steps.splice(at(r => r.unit === 'hostyour-vault-reload.timer')(p), 1); },
  'books_here_in_answers dropped': p => {
    const row = p.steps[reloadService(p)];
    row.when = row.when.filter(w => w !== 'books_here_in_answers');
  },
  'the pod restarted after the reload': p => { p.templates[SERVICE] += 'ExecStartPost=/snap/bin/microk8s kubectl -n vault delete pod vault-0\n'; },
  'the timer hourly': p => { p.templates[TIMER] = p.templates[TIMER].replace('OnCalendar=daily', 'OnCalendar=hourly'); },
  'the rows before the store': p => {
    const [row] = p.steps.splice(reloadService(p), 1);
    p.steps.unshift(row);
  },
};
const INNOCENT = {
  'the gates in the other order': p => { p.steps[reloadService(p)].when.reverse(); },
  'the service explained in other words': p => { p.templates[SERVICE] = p.templates[SERVICE].replace(/^# WHAT THIS SERVICE IS FOR\..*$/m, '# Why this exists.'); },
};

test('PLANTED DEFECT: each way the reload breaks is found', () => {
  for (const [name, plant] of Object.entries(PLANTED)) {
    const planted = structuredClone({steps, templates});
    plant(planted);
    assert.notDeepEqual(findings(planted), [], name);
  }
});

test('PLANTED INNOCENT: what the rule does not forbid stays green', () => {
  for (const [name, plant] of Object.entries(INNOCENT)) {
    const planted = structuredClone({steps, templates});
    plant(planted);
    assert.deepEqual(findings(planted), [], name);
  }
});
