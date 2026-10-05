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
// one tenant shaped like the company tenant at the XS size, and the kubelet's hard-eviction reserve that
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

// THE MASTER'S OWN FLOOR, the first row of deploy-branch, which only a master runs. The owner's
// masters are never below 8 processors and 16 GB. What a master schedules, by requests, measured on
// master1 on 2026-10-05: its own pods (the slave part included), one release of the widest unit on
// record (three image builds at once) and one XS tenant, plus the eviction reserve.
const branch = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/deploy-branch.yaml', import.meta.url))], {encoding: 'utf8'}));
const masterNeed = {
  millicores: 3270 + 2250 + xsTenant.millicores,
  memTotalKibibytes: 8208384 + 4718592 + xsTenant.kibibytes + evictionReserveKibibytes,
};

test('deploy-branch refuses a master below 8 processors and the 14,503,936 KiB it schedules, before its first other row', () => {
  const [first] = branch.steps;
  assert.equal(first.step, 'require_machine_size');
  assert.equal(first.on_failure, 'exit');
  assert.equal(first.when, undefined);
  assert.equal(branch.steps.filter(row => row.step === 'require_machine_size').length, 1);
  // master1 as measured: 32 processors and 62,416,164 KiB.
  assert.ok(admits(first, {processors: 32, memTotalKibibytes: 62416164}), 'master1 is refused');
  assert.ok(admits(first, {processors: 8, memTotalKibibytes: masterNeed.memTotalKibibytes}), 'a machine at the floor is refused');
  // A machine sold as 16 GB: 16 GiB, or 16,000,000,000 bytes, each at master1's 7 percent shortfall.
  for (const memTotalKibibytes of [15600000, 14600000]) {
    assert.ok(admits(first, {processors: 8, memTotalKibibytes}), `a 16 GB machine reporting ${memTotalKibibytes} KiB is refused`);
  }
  for (const below of [
    {processors: 5, memTotalKibibytes: 62416164},
    {processors: 7, memTotalKibibytes: 62416164},
    {processors: 8, memTotalKibibytes: masterNeed.memTotalKibibytes - 1},
    {processors: 8, memTotalKibibytes: 11600000},
    {processors: floor.processors, memTotalKibibytes: floor.memTotalKibibytes},
  ]) {
    assert.ok(!admits(first, below), `a master at ${below.processors} processors and ${below.memTotalKibibytes} KiB is admitted`);
  }
  // The floor is what a master schedules.
  assert.ok(first.vcpu * 1000 >= masterNeed.millicores);
  assert.equal(first.memory_kibibytes, masterNeed.memTotalKibibytes);
});
