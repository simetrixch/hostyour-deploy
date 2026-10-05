import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// publish-mail-dkim runs where the domain's mail belongs to another mail service, which owns the
// apex SPF, its own DKIM selectors and the DMARC policy. The program may write one record: the DKIM
// key under the platform signer's selector, which is a stage.
const STAGES = ['dev', 'test', 'prod'];
const program = JSON.parse(execFileSync('yq', ['-o=json', '.',
  fileURLToPath(new URL('../ansiwise/programs/publish-mail-dkim.yaml', import.meta.url))], {encoding: 'utf8'}));

/** Every way the program reaches beyond the one DKIM record under a stage selector. */
function findings(p) {
  const found = [];
  const steps = p.steps.map(row => row.step);
  if (steps.join(',') !== 'cloudflare_dkim_record') found.push(`steps ${steps.join(', ')}, not the one DKIM row`);
  const dkim = p.steps.find(row => row.step === 'cloudflare_dkim_record');
  if (dkim && dkim.public_key !== undefined) found.push('the key is read from the store, where the relay\'s pair stands');
  const selector = p.answers.find(a => a.name === dkim?.selector_answer);
  if (!selector || JSON.stringify(selector.allowed) !== JSON.stringify(STAGES)) found.push('the selector is not limited to a stage');
  if (selector?.default_from !== undefined || selector?.required === false) found.push('the selector may be left unanswered');
  return found;
}

test('the program writes one DKIM record under a stage selector, with the answered key, and nothing else', () => {
  assert.deepEqual(findings(program), []);
});

test('PLANTED: an SPF row, a DMARC row, a key read from the store and a free selector are each found', () => {
  const dkim = program.steps[0];
  const selector = program.answers.find(a => a.name === dkim.selector_answer);
  const other = program.answers.filter(a => a !== selector);
  assert.deepEqual(findings({...program, steps: [{step: 'cloudflare_spf_record'}, dkim]}), ['steps cloudflare_spf_record, cloudflare_dkim_record, not the one DKIM row']);
  assert.deepEqual(findings({...program, steps: [dkim, {step: 'cloudflare_dmarc_record'}]}), ['steps cloudflare_dkim_record, cloudflare_dmarc_record, not the one DKIM row']);
  assert.deepEqual(findings({...program, steps: [{...dkim, public_key: {measured: 'dkim_public_key'}}]}), ['the key is read from the store, where the relay\'s pair stands']);
  // selector1 and selector2 are the mail service's own selectors; a free text could name them.
  assert.deepEqual(findings({...program, answers: [...other, {...selector, allowed: undefined}]}), ['the selector is not limited to a stage']);
  assert.deepEqual(findings({...program, answers: [...other, {...selector, default_from: 'stage'}]}), ['the selector may be left unanswered']);
});
