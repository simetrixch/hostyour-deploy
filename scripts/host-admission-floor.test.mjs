import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-host.yaml', import.meta.url))], {encoding: 'utf8'}));
const rows = program.steps.filter(row => row.step === 'require_machine_size');
// The comparison ansiwise-host require_machine_size.dart makes: refused below either figure, admitted at both.
const admits = (row, machine) => machine.processors >= row.vcpu && machine.memTotalKibibytes >= row.memory_kibibytes;

// What an app host must schedule, by requests, measured on apps3 on 2026-10-04: the platform's own pods,
// one tenant shaped like simetrix at the XS size, and the kubelet's hard-eviction reserve that
// allocatable memory lacks against MemTotal.
const platform = {millicores: 2140, kibibytes: 4849664};
const xsTenant = {millicores: 290, kibibytes: 1474560};
const evictionReserveKibibytes = 102400;
const floor = {
  processors: Math.ceil((platform.millicores + xsTenant.millicores) / 1000),
  memTotalKibibytes: platform.kibibytes + xsTenant.kibibytes + evictionReserveKibibytes,
};

test('deploy-host admits a machine exactly at the platform-plus-XS floor and refuses one below it', () => {
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.on_failure, 'exit');
  assert.ok(admits(row, floor), `a machine at ${floor.processors} processors and ${floor.memTotalKibibytes} KiB is refused`);
  assert.ok(admits(row, {processors: 24, memTotalKibibytes: 63737464}), 'an apps2-sized machine is refused');
  for (const below of [
    {processors: 2, memTotalKibibytes: 4000000},
    {processors: floor.processors - 1, memTotalKibibytes: floor.memTotalKibibytes},
    {processors: floor.processors, memTotalKibibytes: floor.memTotalKibibytes - 1},
  ]) {
    assert.ok(!admits(row, below), `a machine at ${below.processors} processors and ${below.memTotalKibibytes} KiB is admitted`);
  }
});
