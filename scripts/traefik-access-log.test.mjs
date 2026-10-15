import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer as createHttpServer} from 'node:http';
import {connect, createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// deploy-cluster gives the ingress controller an access log that keeps metadata only, and no trust
// of forwarded headers. The declaration is read from the program and run on the Traefik binary the
// MicroK8s ingress addon ships (docker.io/traefik:v3.6.2 on every cluster), because what the field
// modes drop is decided by that binary and not by its documentation.
const SHIPPED_VERSION = '3.6.2';
const STANDING = '--providers.kubernetescrd.allowCrossNamespace=true';
const KEPT = ['ClientAddr', 'RouterName', 'ServiceName', 'DownstreamStatus', 'Duration', 'DownstreamContentSize'];
// What logrus writes into every JSON line on its own.
const ALLOWED = new Set([...KEPT, 'level', 'msg', 'time']);

const program = fileURLToPath(new URL('../ansiwise/programs/deploy-cluster.yaml', import.meta.url));
const steps = JSON.parse(execFileSync('yq', ['-o=json', '.', program], {encoding: 'utf8'})).steps;
const declared = steps.find(row => row.step === 'patch_container_arguments_and_ports' && row.namespace === 'ingress' && row.name === 'traefik').arguments;
const accessArguments = declared.filter(argument => argument.startsWith('--accesslog'));

// Each request carries a marker in one place a caller controls. The forged addresses come from the
// documentation ranges, so a match can only be the forgery.
const MARKER = 'zq7marker';
const FORGED = ['203.0.113.77', '198.51.100.88', '192.0.2.99'];
const REQUESTS = [
  `GET /${MARKER}path?token=${MARKER}query HTTP/1.1\r\nHost: fixture.test\r\n`,
  `GET / HTTP/1.1\r\nHost: fixture.test\r\nCookie: session=${MARKER}cookie\r\n`,
  `GET / HTTP/1.1\r\nHost: fixture.test\r\nAuthorization: Bearer ${MARKER}authorization\r\n`,
  `GET http://${MARKER}user:${MARKER}password@fixture.test/ HTTP/1.1\r\nHost: fixture.test\r\n`,
  `GET / HTTP/1.1\r\nHost: fixture.test\r\nX-Fixture: ${MARKER}header\r\n`,
  `GET / HTTP/1.1\r\nHost: fixture.test\r\nX-Forwarded-For: ${FORGED[0]}\r\nX-Real-Ip: ${FORGED[1]}\r\n`,
  `GET / HTTP/1.1\r\nHost: fixture.test\r\nCF-Connecting-IP: ${FORGED[2]}\r\n`,
  `${MARKER.toUpperCase()}METHOD / HTTP/1.1\r\nHost: fixture.test\r\n`,
  `GET / HTTP/1.1\r\nHost: ${MARKER}host.test\r\n`,
].map(head => `${head}Connection: close\r\n\r\n`);

const freePort = () => new Promise((resolve, reject) => {
  const server = createServer().listen(0, '127.0.0.1', () => {
    const {port} = server.address();
    server.close(() => resolve(port));
  });
  server.on('error', reject);
});
// Written without closing the socket's own side: Traefik reads that half-close as a client that
// left, and answers 499 instead of routing. `Connection: close` ends the exchange from its side.
const send = (port, request) => new Promise((resolve, reject) => {
  const socket = connect(port, '127.0.0.1', () => socket.write(request));
  let answer = '';
  socket.on('data', chunk => { answer += chunk; });
  socket.on('end', () => resolve(answer));
  socket.on('error', reject);
});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Starts the binary with [argumentsUnderTest] in front of a service that records what it gets. */
async function run(argumentsUnderTest) {
  const folder = mkdtempSync(join(tmpdir(), 'traefik-access-log-'));
  const received = [];
  const service = createHttpServer((request, response) => { received.push(request.headers); response.end('ok'); });
  await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
  const port = await freePort();
  const routes = {http: {
    routers: {fixture: {rule: 'PathPrefix(`/`)', entryPoints: ['web'], service: 'fixture'}},
    services: {fixture: {loadBalancer: {servers: [{url: `http://127.0.0.1:${service.address().port}`}]}}},
  }};
  writeFileSync(join(folder, 'routes.yaml'), JSON.stringify(routes));
  const traefik = spawn('traefik', [
    ...argumentsUnderTest,
    `--entryPoints.web.address=127.0.0.1:${port}`,
    `--providers.file.filename=${join(folder, 'routes.yaml')}`,
    `--log.filePath=${join(folder, 'traefik.log')}`,
    '--global.checkNewVersion=false',
    '--global.sendAnonymousUsage=false',
  ], {stdio: ['ignore', 'pipe', 'inherit']});
  let output = '';
  traefik.stdout.on('data', chunk => { output += chunk; });
  try {
    let ready = false;
    for (let tries = 0; tries < 100 && !ready; tries++) {
      ready = (await send(port, 'GET / HTTP/1.1\r\nHost: fixture.test\r\nConnection: close\r\n\r\n').catch(() => '')).startsWith('HTTP/1.1 200');
      if (!ready) await pause(100);
    }
    assert.ok(ready, `traefik never routed to the fixture service:\n${readFileSync(join(folder, 'traefik.log'), 'utf8')}`);
    await pause(200);
    const mark = output.length;
    const seen = received.length;
    for (const request of REQUESTS) await send(port, request);
    for (let tries = 0; tries < 20 && output.slice(mark).split('\n').filter(Boolean).length < REQUESTS.length; tries++) await pause(100);
    return {access: output.slice(mark), own: readFileSync(join(folder, 'traefik.log'), 'utf8'), received: received.slice(seen)};
  } finally {
    traefik.kill();
    await new Promise(resolve => traefik.once('exit', resolve));
    service.close();
    rmSync(folder, {recursive: true, force: true});
  }
}

/** Every way the evidence of [observed] falls short or says too much. */
function findings({access, own, received}) {
  const found = [];
  const lines = access.split('\n').filter(Boolean);
  if (lines.length !== REQUESTS.length) found.push(`${lines.length} access lines for ${REQUESTS.length} requests`);
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { found.push('a line that is not JSON'); continue; }
    const extra = Object.keys(entry).filter(field => !ALLOWED.has(field));
    if (extra.length > 0) found.push(`a line keeps ${extra.join(', ')}`);
    const missing = KEPT.filter(field => !(field in entry));
    if (missing.length > 0) found.push(`a line lacks ${missing.join(', ')}`);
    if ('ClientAddr' in entry && !String(entry.ClientAddr).startsWith('127.0.0.1:')) found.push(`ClientAddr ${entry.ClientAddr} is not the socket peer`);
  }
  const logs = (access + own).toLowerCase();
  if (logs.includes(MARKER)) found.push('a caller\'s marker reached a log');
  for (const address of FORGED) if (logs.includes(address)) found.push(`the forged ${address} reached a log`);
  for (const headers of received) {
    if (headers['x-forwarded-for'] !== '127.0.0.1') found.push(`the service got X-Forwarded-For ${headers['x-forwarded-for']}`);
    if (headers['x-real-ip'] !== '127.0.0.1') found.push(`the service got X-Real-Ip ${headers['x-real-ip']}`);
  }
  return [...new Set(found)];
}

test('deploy-cluster declares the access log beside the standing argument, and no forwarded-header trust', () => {
  const stray = arguments_ => arguments_.filter(argument => argument !== STANDING && !argument.startsWith('--accesslog'));
  assert.ok(declared.includes(STANDING));
  assert.deepEqual(stray(declared), []);
  assert.notDeepEqual(stray([...declared, '--entryPoints.websecure.forwardedHeaders.insecure=true']), [], 'PLANTED DEFECT: forwarded headers trusted');
});

test(`the binary under test is Traefik ${SHIPPED_VERSION}`, () => {
  assert.match(execFileSync('traefik', ['version'], {encoding: 'utf8'}), new RegExp(`^Version:\\s+${SHIPPED_VERSION.replaceAll('.', '\\.')}$`, 'm'));
});

test('the declared access log writes one metadata line per request and nothing a caller chose', async () => {
  assert.deepEqual(findings(await run(accessArguments)), []);
});

test('PLANTED DEFECT: each way to log too much or too little, or to trust a forgery, is found', async () => {
  const without = unwanted => accessArguments.filter(argument => argument !== unwanted);
  const planted = {
    'the drop policy is gone': without('--accesslog.fields.defaultmode=drop'),
    'the raw forwarded address is kept': [...accessArguments, '--accesslog.fields.names.ClientHost=keep'],
    'the path with its query is kept': [...accessArguments, '--accesslog.fields.names.RequestPath=keep'],
    'the request headers are kept': [...without('--accesslog.fields.headers.defaultmode=drop'), '--accesslog.fields.headers.defaultmode=keep'],
    'the logger is off': [],
    'every peer is trusted with forwarded headers': [...accessArguments, '--entryPoints.web.forwardedHeaders.insecure=true'],
  };
  for (const [name, arguments_] of Object.entries(planted)) {
    assert.notDeepEqual(findings(await run(arguments_)), [], name);
  }
});
