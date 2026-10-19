import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The cluster map names where the finished site statistics are read: the tenant charts hand
// global.endpoints.observability.query to the admin, so a cluster map without it leaves every
// Visitors and Security page with nothing to ask.
const template = readFileSync(fileURLToPath(new URL('../ansiwise/templates/cluster-map.tpl', import.meta.url)), 'utf8');
const endpoints = text => text.split('\n').find(line => line.trim().startsWith('observability: {')) ?? '';
const addresses = line => Object.fromEntries([...line.matchAll(/(\w+): '([^']*)'/g)].map(([, key, value]) => [key, value]));

test('the cluster map carries the push routes and the query route of the observability plane', () => {
  assert.deepEqual(addresses(endpoints(template)), {
    prometheusPush: 'https://prom-push.<books-cluster>',
    lokiPush: 'https://loki-push.<books-cluster>',
    query: 'https://observability-query.<books-cluster>',
  });
});

test('PLANTED DEFECT: a map without the query route, or with a host of its own, is found', () => {
  const line = endpoints(template);
  assert.notDeepEqual(addresses(line.replace(/, query: '[^']*'/, '')), addresses(line), 'query route removed');
  assert.notDeepEqual(addresses(line.replace('observability-query.<books-cluster>', 'obs.example.com')), addresses(line), 'query route on a host of its own');
});

test('no word of the cluster map names the server that holds the books', () => {
  assert.doesNotMatch(endpoints(template), /master/i);
});
