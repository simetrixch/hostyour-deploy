import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// Where Argo CD reads the platform tree and the deploy repository from. deploy-branch writes both
// addresses into the cluster map, as `global.platformUrl` and `global.deployUrl`: on Forgejo where the
// platform repository has moved there, on github.com where it has not. register-slave and
// remove-slave name the platform tree in the sourceRepos of the slave's project on the master, and the
// Manager hands them that address as `platform_url`.
const at = path => fileURLToPath(new URL(`../${path}`, import.meta.url));
const yaml = (text, expression = '.') => JSON.parse(execFileSync('yq', ['-o=json', expression, '-'], {input: text, encoding: 'utf8'}));
const program = name => yaml(readFileSync(at(`ansiwise/programs/${name}.yaml`), 'utf8'));
const MAP = 'ansiwise/templates/cluster-map.tpl';
const PROJECT = 'ansiwise/templates/slave-appproject.tpl';
const mapText = readFileSync(at(MAP), 'utf8');
const projectText = readFileSync(at(PROJECT), 'utf8');
const branch = program('deploy-branch');
const register = program('register-slave');
const remove = program('remove-slave');

// A carried slot (`<name!?>`) is filled from the file as it stands and is bound by no row.
const slotsOf = text => [...new Set(text.split('\n').filter(line => !line.trimStart().startsWith('#'))
  .flatMap(line => [...line.matchAll(/<([a-z][a-z0-9-]*)(\?)?>/g)].map(match => match[1])))];
const rowsWriting = (steps, template) => steps.filter(step => step.step === 'write_file_from_template' && step.template === template);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// THE THREE SLOTS THAT DIFFER BETWEEN THE TWO FORGES. Everything else the map says is one statement
// of this run, so the two rows must bind it alike.
const FORGE_SLOTS = ['platform-host', 'platform-repository', 'deploy-repository'];
const ON_FORGEJO = {
  'platform-host': {answer: 'forgejo_host'},
  'platform-repository': {answer: 'forgejo_platform_repository'},
  'deploy-repository': {answer: 'forgejo_deploy_repository'},
};
const ON_GITHUB = {'platform-host': 'github.com', 'platform-repository': {answer: 'platform_repo'}, 'deploy-repository': {answer: 'deploy_repo'}};
const ANSWERS = {
  forgejo_host: 'forgejo.master.example.invalid', forgejo_platform_repository: 'team/platform', forgejo_deploy_repository: 'team/deploy',
  platform_repo: 'acme/hostyour-cloud', deploy_repo: 'acme/acme-deploy',
};
const WANT = {
  platform_on_forgejo_in_answers: {platformUrl: 'https://forgejo.master.example.invalid/team/platform.git', deployUrl: 'https://forgejo.master.example.invalid/team/deploy.git'},
  platform_on_github_in_answers: {platformUrl: 'https://github.com/acme/hostyour-cloud.git', deployUrl: 'https://github.com/acme/acme-deploy.git'},
};

/** The map as the row renders it: the bound slots from the sample answers, every other slot as a marker. */
function renderedMap(row, template) {
  return template.replace(/<([a-z][a-z0-9-]*)[?!]*>/g, (slot, name) => {
    const binding = row.values?.[name];
    if (typeof binding === 'string') return binding;
    return binding?.answer === undefined ? `__${name}__` : ANSWERS[binding.answer] ?? `__${binding.answer}__`;
  });
}

/** Every way deploy-branch and the map template break the rule, named. */
function mapFindings(steps, template) {
  const found = [];
  if (/^\s*deployRepo:/m.test(template) || slotsOf(template).includes('deploy-repo')) found.push('the map still writes deployRepo');
  const rows = rowsWriting(steps, MAP);
  const byCondition = Object.fromEntries(Object.keys(WANT).map(name => [name, rows.filter(row => same(row.when, [name]))]));
  if (rows.length !== 2 || Object.values(byCondition).some(list => list.length !== 1)) {
    return [...found, `${rows.length} rows write the map, ${Object.entries(byCondition).map(([name, list]) => `${list.length} on ${name}`).join(' and ')}, not one on each`];
  }
  const slots = slotsOf(template);
  for (const [condition, [row]] of Object.entries(byCondition)) {
    const bound = Object.keys(row.values ?? {});
    for (const slot of slots.filter(name => !bound.includes(name))) found.push(`the row on ${condition} binds no ${slot}`);
    for (const slot of bound.filter(name => !slots.includes(name))) found.push(`the row on ${condition} binds ${slot}, which the map has no slot for`);
    const wanted = condition === 'platform_on_forgejo_in_answers' ? ON_FORGEJO : ON_GITHUB;
    for (const slot of FORGE_SLOTS) {
      if (!same(row.values?.[slot], wanted[slot])) found.push(`the row on ${condition} fills ${slot} from ${JSON.stringify(row.values?.[slot])}`);
    }
    const map = yaml(renderedMap(row, template), '.global');
    for (const [key, value] of Object.entries(WANT[condition])) {
      if (map?.[key] !== value) found.push(`the row on ${condition} writes global.${key} ${map?.[key]}, not ${value}`);
    }
    if (map?.deployRepo !== undefined) found.push(`the row on ${condition} writes global.deployRepo`);
  }
  const [forgejo, github] = [byCondition.platform_on_forgejo_in_answers[0], byCondition.platform_on_github_in_answers[0]];
  const rest = row => ({...row, when: undefined, values: Object.fromEntries(Object.entries(row.values ?? {}).filter(([slot]) => !FORGE_SLOTS.includes(slot)))});
  if (!same(rest(forgejo), rest(github))) found.push('the two rows differ in more than the three slots of the forge');
  return found;
}

test('the cluster map is written with the platform and deploy addresses of the forge the platform tree stands on', () => {
  assert.deepEqual(mapFindings(branch.steps, mapText), []);
});

test('PLANTED DEFECT: a map row on the wrong forge, a drifted row, a lone row and the old deployRepo key are each found', () => {
  const planted = {
    'the GitHub row takes Forgejo\'s host': [steps => { rowsWriting(steps, MAP).find(row => row.when[0] === 'platform_on_github_in_answers').values['platform-host'] = {answer: 'forgejo_host'}; }, /fills platform-host/],
    'the Forgejo row takes the GitHub deploy repository': [steps => { rowsWriting(steps, MAP).find(row => row.when[0] === 'platform_on_forgejo_in_answers').values['deploy-repository'] = {answer: 'deploy_repo'}; }, /fills deploy-repository/],
    'the rows disagree on the stage': [steps => { rowsWriting(steps, MAP).find(row => row.when[0] === 'platform_on_github_in_answers').values.stage = {answer: 'fqdn'}; }, /differ in more than the three slots/],
    'the rows disagree on the file mode': [steps => { rowsWriting(steps, MAP)[0].file_mode = 384; }, /differ in more than the three slots/],
    'only one row writes the map': [steps => { steps.splice(steps.indexOf(rowsWriting(steps, MAP)[1]), 1); }, /1 rows write the map/],
    'a row writes the map on every run': [steps => { delete rowsWriting(steps, MAP)[0].when; }, /not one on each/],
    'a row binds a slot the map does not have': [steps => { rowsWriting(steps, MAP)[0].values['deploy-repo'] = {answer: 'deploy_repo'}; }, /has no slot for/],
    'a row leaves a slot unbound': [steps => { delete rowsWriting(steps, MAP)[0].values['platform-host']; }, /binds no platform-host/],
  };
  for (const [name, [plant, expected]] of Object.entries(planted)) {
    const steps = structuredClone(branch.steps);
    plant(steps);
    assert.match(mapFindings(steps, mapText).join('\n'), expected, name);
  }
  const keeps = mapFindings(branch.steps, `${mapText.trimEnd()}\n  deployRepo: <deploy-repo>\n`);
  assert.match(keeps.join('\n'), /still writes deployRepo/);
  const literal = mapText.replace(/^( {2}platformUrl:).*$/m, '$1 https://github.com/<platform-repository>.git');
  assert.notEqual(literal, mapText, 'the planted map must differ');
  assert.match(mapFindings(branch.steps, literal).join('\n'), /on platform_on_forgejo_in_answers writes global\.platformUrl/);
});

test('PLANTED INNOCENT: a reworded comment and a reordered pair of rows stay accepted', () => {
  assert.deepEqual(mapFindings(branch.steps, `# Reworded.\n${mapText}`), []);
  const reordered = structuredClone(branch.steps);
  const [first, second] = rowsWriting(reordered, MAP);
  const [at1, at2] = [reordered.indexOf(first), reordered.indexOf(second)];
  [reordered[at1], reordered[at2]] = [second, first];
  assert.deepEqual(mapFindings(reordered, mapText), []);
});

// THE SLAVE'S PROJECT ON THE MASTER names the platform tree as a source and nothing else of the tree.
const PROJECT_SLOTS = ['platform-url', 'slave-cluster-name'];
const PROJECT_BINDINGS = {'slave-cluster-name': {answer: 'slave_cluster_name'}, 'platform-url': {answer: 'platform_url'}};
const GOOD_URLS = ['https://github.com/simetrixch/hostyour-cloud.git', 'https://forge.example.com/acme/platform.git', 'https://forge.example.com:3000/acme/platform.git'];
const BAD_URLS = ['*', '', 'http://forge.example.com/acme/platform.git', 'https://forge.example.com/acme/platform', 'https://forge.example.com/acme/platform.git\n', 'https://forge.example.com/a/b/c.git', 'https://x/../y.git'];

/** Every way register-slave or remove-slave, or the project template, breaks the rule, named. */
function projectFindings(programs, template) {
  const found = [];
  if (!same(slotsOf(template).sort(), PROJECT_SLOTS)) found.push(`the project has the slots ${slotsOf(template).sort().join(', ')}`);
  if (/^\s*-\s*https:\/\/github\.com\//m.test(template)) found.push('the project lists a github.com source of its own');
  const filled = template.replace('<platform-url>', 'https://forgejo.master.example.invalid/team/platform.git').replaceAll('<slave-cluster-name>', 'apps1');
  const sources = yaml(filled, '.spec.sourceRepos');
  if (!same(sources?.[0], 'https://forgejo.master.example.invalid/team/platform.git')) found.push(`the first source of the project is ${sources?.[0]}`);
  if (!sources?.includes('oci://zot.master.digitacloud.app/simetrixch/argoproj.github.io/argo-helm')) found.push('the project lost the source of the reconciler chart');
  for (const [name, one] of Object.entries(programs)) {
    const answer = one.answers.find(declared => declared.name === 'platform_url');
    if (answer?.kind !== 'text' || answer.required !== true) found.push(`${name} does not declare platform_url as required text`);
    const rows = rowsWriting(one.steps, PROJECT);
    if (rows.length !== 1 || !same(rows[0].values, PROJECT_BINDINGS)) found.push(`${name} fills the project from ${JSON.stringify(rows.map(row => row.values))}`);
    const check = one.steps.findIndex(step => step.step === 'require_answer_matches' && step.answer === 'platform_url');
    const firstChange = one.steps.findIndex(step => !['require_commands', 'require_answer_matches'].includes(step.step));
    if (check < 0 || check > firstChange) found.push(`${name} checks platform_url at step ${check}, after its first row that changes something (step ${firstChange})`);
    else {
      const {pattern, on_failure: onFailure} = one.steps[check];
      const refuses = onFailure === 'exit' && GOOD_URLS.every(url => new RegExp(pattern).test(url)) && BAD_URLS.every(url => !new RegExp(pattern).test(url));
      if (!refuses) found.push(`${name} does not refuse a platform_url that is no https repository address`);
    }
  }
  return found;
}

test('the slave\'s project names the platform tree from platform_url, which both programs take and check first', () => {
  assert.deepEqual(projectFindings({'register-slave': register, 'remove-slave': remove}, projectText), []);
});

test('PLANTED DEFECT: a program without platform_url, a project with the literal, an unbound slot and an unchecked answer are each found', () => {
  const programs = () => ({'register-slave': structuredClone(register), 'remove-slave': structuredClone(remove)});
  const planted = {
    'remove-slave declares no platform_url': [one => { one['remove-slave'].answers = one['remove-slave'].answers.filter(a => a.name !== 'platform_url'); }, /remove-slave does not declare platform_url/],
    'register-slave takes platform_url as optional': [one => { one['register-slave'].answers.find(a => a.name === 'platform_url').required = false; }, /register-slave does not declare/],
    'the project row leaves platform-url unbound': [one => { delete rowsWriting(one['register-slave'].steps, PROJECT)[0].values['platform-url']; }, /register-slave fills the project from/],
    'the project row binds another answer': [one => { rowsWriting(one['remove-slave'].steps, PROJECT)[0].values['platform-url'] = {answer: 'api_server_url'}; }, /remove-slave fills the project from/],
    'the check stands after the first row that changes something': [one => { const steps = one['register-slave'].steps; steps.push(...steps.splice(steps.findIndex(step => step.answer === 'platform_url'), 1)); }, /register-slave checks platform_url at step/],
    'the check refuses nothing': [one => { one['remove-slave'].steps.find(s => s.answer === 'platform_url').pattern = '.*'; }, /remove-slave does not refuse a platform_url/],
    'the check only warns': [one => { one['register-slave'].steps.find(s => s.answer === 'platform_url').on_failure = 'continue'; }, /register-slave does not refuse a platform_url/],
  };
  for (const [name, [plant, expected]] of Object.entries(planted)) {
    const one = programs();
    plant(one);
    assert.match(projectFindings(one, projectText).join('\n'), expected, name);
  }
  const literal = projectText.replace('<platform-url>', 'https://github.com/simetrixch/hostyour-cloud.git');
  assert.match(projectFindings(programs(), literal).join('\n'), /the project has the slots|lists a github\.com source|first source of the project/);
  const lost = projectText.replace(/^ {4}- oci:.*$/m, '');
  assert.match(projectFindings(programs(), lost).join('\n'), /lost the source of the reconciler chart/);
});

test('PLANTED INNOCENT: a reworded refusal and a reworded project description stay accepted', () => {
  const one = {'register-slave': structuredClone(register), 'remove-slave': structuredClone(remove)};
  one['register-slave'].steps[0].refusal += ' Please check the Manager.';
  assert.deepEqual(projectFindings(one, projectText.replace('its namespaced reconciler instance', 'its reconciler instance')), []);
});
