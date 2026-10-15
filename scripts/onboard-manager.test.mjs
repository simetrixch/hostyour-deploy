import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const program = JSON.parse(execFileSync('yq', ['-o=json', '.', join(root, 'ansiwise/programs/onboard-manager.yaml')], {encoding: 'utf8'}));
const repositoryFile = 'https://api.github.com/repos/simetrixch/hostyour-manager/contents/deploy/platform.yaml';
const answer = 'build_manager_repo_write_pat';

function findings(program) {
  const found = [];
  const probe = program.steps[0];
  if (probe.step !== 'wait_for_http_field' || probe.url !== repositoryFile ||
      probe.bearer_answer !== answer || probe.field !== 'type' ||
      JSON.stringify(probe.until) !== '["file"]' || probe.on_failure !== 'exit' ||
      !(probe.timeout_seconds > 0 && probe.timeout_seconds <= 30)) found.push('repository access is not proved before any Manager request');
  const prompt = program.answers.find(a => a.name === answer);
  if (!prompt?.secret || !/private simetrixch\/hostyour-manager/.test(prompt.describes) ||
      !/Contents: Read/.test(prompt.describes)) found.push('the secret prompt does not name private repository read access');
  const create = program.steps.find(s => s.url === '<manager-url>/api/consumers');
  if (/repoPat|repo-pat/.test(JSON.stringify(create))) found.push('the unused raw PAT still enters the Manager request');
  return found;
}

test('the supplied secret proves private repository Contents access before the Manager is called', () => {
  assert.deepEqual(findings(program), []);
});

test('PLANTED DEFECT: missing or late probe, another bearer and the ignored payload are detected', () => {
  for (const change of [
    p => p.steps.shift(),
    p => p.steps.push(p.steps.shift()),
    p => { p.steps[0].bearer_answer = 'another_pat'; },
    p => { p.steps.find(s => s.url === '<manager-url>/api/consumers').body += 'repoPat'; },
  ]) {
    const changed = structuredClone(program);
    change(changed);
    assert.notDeepEqual(findings(changed), []);
  }
});

test('PLANTED INNOCENT: another bounded timeout keeps the same access contract', () => {
  const changed = structuredClone(program);
  changed.steps[0].timeout_seconds = 10;
  assert.deepEqual(findings(changed), []);
});

function recordText(directory) {
  return readdirSync(directory, {withFileTypes: true}).map(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? recordText(path) : readFileSync(path, 'utf8');
  }).join('\n');
}

async function run(program, repositoryStatus) {
  const dir = mkdtempSync(join(tmpdir(), 'onboard-manager-'));
  const pat = randomBytes(24).toString('hex');
  const session = randomBytes(24).toString('hex');
  const requests = [];
  let hasExactPat = true;
  let hasOnlySession = true;
  let hasRawPat = false;
  const respond = (req, res) => {
    requests.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === new URL(repositoryFile).pathname) {
      hasExactPat &&= req.headers.authorization === `Bearer ${pat}`;
      res.statusCode = repositoryStatus;
      return res.end(JSON.stringify(repositoryStatus === 200 ? {type: 'file'} : {message: 'Not Found'}));
    }
    if (req.url === '/auth/session') return res.end(JSON.stringify({session}));
    hasOnlySession &&= req.headers.authorization === `Bearer ${session}`;
    if (req.url === '/api/consumers') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        hasRawPat ||= body.includes(pat) || Object.hasOwn(JSON.parse(body), 'repoPat');
        res.statusCode = 201;
        res.end(JSON.stringify({runId: 'run_fixture'}));
      });
      return;
    }
    if (req.url === '/api/runs/run_fixture/approve') {
      res.statusCode = 202;
      return res.end(JSON.stringify({ok: true}));
    }
    res.end(JSON.stringify({status: requests.includes('/api/runs/run_fixture/approve') ? 'succeeded' : 'planned'}));
  };
  const http = createServer(respond);
  const socket = createServer(respond);
  try {
    await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
    const socketPath = join(dir, 'admin.sock');
    await new Promise(resolve => socket.listen(socketPath, resolve));
    const origin = `http://127.0.0.1:${http.address().port}`;
    const controlled = structuredClone(program);
    for (const step of controlled.steps) {
      if (step.url === repositoryFile) step.url = origin + new URL(repositoryFile).pathname;
    }
    mkdirSync(join(dir, 'programs'));
    writeFileSync(join(dir, 'programs/onboard-manager.yaml'), JSON.stringify(controlled));
    const input = JSON.stringify({answers: {
      stage: 'prod', channel: 'stable', manager_url: origin, admin_socket_path: socketPath, [answer]: pat,
    }});
    let output = '';
    let exitCode;
    for (const mode of ['test', 'dry', 'run']) {
      const binary = process.env.ANSIWISE_BIN;
      const cli = process.env.ANSIWISE_CLI_CHECKOUT;
      assert.ok(binary || cli, 'set ANSIWISE_BIN or ANSIWISE_CLI_CHECKOUT; the HTTP regression must run, never skip');
      const args = [controlled.name, '--mode', mode, '--config', join(root, 'ansiwise.yaml'),
        '--programs', join(dir, 'programs'), '--runs', join(dir, 'runs'), '--answers', '-', '--without-elevation-password'];
      const child = spawn(binary || 'dart', binary ? args : ['run', 'bin/ansiwise.dart', ...args], {
        cwd: binary ? dir : cli, stdio: ['pipe', 'pipe', 'pipe'],
      });
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { output += chunk; });
      const completed = once(child, 'close');
      child.stdin.end(input);
      [exitCode] = await completed;
      if (exitCode !== 0) break;
    }
    const record = output + recordText(join(dir, 'runs'));
    assert.equal(record.includes(pat) || record.includes(session), false, 'a secret reached CLI output or run records');
    return {exitCode, requests, hasExactPat, hasOnlySession, hasRawPat, output};
  } finally {
    await Promise.all([http, socket].map(server => new Promise(resolve => server.close(resolve))));
    rmSync(dir, {recursive: true, force: true});
  }
}

for (const status of [404, 403]) {
  test(`valid PAT without private Contents access (HTTP ${status}) creates no onboarding run`, {timeout: 90_000}, async () => {
    const result = await run(program, status);
    assert.equal(result.requests.includes('/api/consumers'), false, 'a refused PAT created an onboarding run');
    assert.ok(result.requests.includes(new URL(repositoryFile).pathname), result.output);
    assert.equal(result.hasExactPat, true);
    assert.notEqual(result.exitCode, 0);
  });
}

test('accessible PAT proceeds through the real HTTP steps without forwarding the PAT to the Manager', {timeout: 90_000}, async () => {
  const result = await run(program, 200);
  assert.equal(result.exitCode, 0, result.output);
  assert.ok(result.requests.indexOf(new URL(repositoryFile).pathname) < result.requests.indexOf('/auth/session'));
  assert.equal(result.hasExactPat && result.hasOnlySession, true);
  assert.equal(result.hasRawPat, false);
  assert.equal(result.requests.filter(path => path === '/api/consumers').length, 1);
});
