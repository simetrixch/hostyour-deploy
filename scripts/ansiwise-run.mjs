import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Runs one program definition through the real ansiwise binary, or through the CLI checkout, once per
// mode in order, and stops at the first mode that does not exit 0. It returns that mode's exit code,
// everything it printed and the events of its record. The modes share one directory of run records,
// because a `run` needs a clean `dry` of the same input in it. The program is written to a directory
// of its own, so a test shapes the rows it is about and nothing else runs.
export function ansiwiseRun({definition, config, modes, answers}) {
  const binary = process.env.ANSIWISE_BIN;
  const cli = process.env.ANSIWISE_CLI_CHECKOUT;
  assert.ok(binary || cli, 'set ANSIWISE_BIN or ANSIWISE_CLI_CHECKOUT; real-CLI coverage may not skip');
  const dir = mkdtempSync(join(tmpdir(), 'ansiwise-run-'));
  try {
    mkdirSync(join(dir, 'programs'));
    writeFileSync(join(dir, 'programs', `${definition.name}.yaml`), JSON.stringify(definition));
    let last;
    for (const mode of modes) {
      const args = [definition.name, '--mode', mode, '--config', config, '--programs', join(dir, 'programs'),
        '--runs', join(dir, 'runs'), '--answers', '-', '--without-elevation-password'];
      const result = spawnSync(binary || 'dart', binary ? args : ['run', 'bin/ansiwise.dart', ...args], {
        cwd: binary ? dir : cli, input: JSON.stringify({answers}), encoding: 'utf8', timeout: 120_000,
      });
      const records = existsSync(join(dir, 'runs'))
        ? readdirSync(join(dir, 'runs'), {recursive: true}).filter(path => path.endsWith('events.jsonl')).sort()
        : [];
      const events = records.length === 0 ? []
        : readFileSync(join(dir, 'runs', records.at(-1)), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
      last = {mode, code: result.status, output: result.stdout + result.stderr, events};
      if (result.status !== 0) break;
    }
    return last;
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}
