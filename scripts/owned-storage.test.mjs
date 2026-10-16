import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

// The installer reads the owner's mirror only for what it downloads from GitHub: the tools of install_pinned_tool by the blob of
// their sha256 (the <sha256> slot of the url, filled from the row's sha256), and the charts of the bootstrap releases and of the
// slave's reconciler project from the oci repositories under zot.master.digitacloud.app/simetrixch. A helm_repository row names
// no chart of the mirror: helm_release takes an oci reference, so its chart is that reference and the row it replaced is gone.
// The hashicorp row stays, because the mirror does not hold the secret store's chart.
const root = fileURLToPath(new URL('..', import.meta.url));
const steps = (program) => JSON.parse(execFileSync('yq', ['-o=json', '.steps', `${root}ansiwise/programs/${program}.yaml`], {encoding: 'utf8'}));
const cluster = steps('deploy-cluster');
const platform = steps('deploy-platform-services');
const slaveProject = readFileSync(`${root}ansiwise/templates/slave-appproject.tpl`, 'utf8');

const OWNED_TOOLS = 'https://zot.master.digitacloud.app/v2/simetrixch/github.com/';
const OWNED_CHARTS = 'oci://zot.master.digitacloud.app/simetrixch/';
const TOOL_URLS = {
  jq: `${OWNED_TOOLS}jqlang/jq/releases/download/<version>/jq-linux-amd64/blobs/sha256:<sha256>`,
  argocd: `${OWNED_TOOLS}argoproj/argo-cd/releases/download/<version>/argocd-linux-amd64/blobs/sha256:<sha256>`,
  yq: `${OWNED_TOOLS}mikefarah/yq/releases/download/<version>/yq_linux_amd64/blobs/sha256:<sha256>`,
  vault: 'https://releases.hashicorp.com/vault/<bare-version>/vault_<bare-version>_linux_amd64.zip',
};
const RELEASE_CHARTS = {
  idp: `${OWNED_CHARTS}charts.goauthentik.io/authentik`,
  headlamp: `${OWNED_CHARTS}kubernetes-sigs.github.io/headlamp/headlamp`,
  argocd: `${OWNED_CHARTS}argoproj.github.io/argo-helm/argo-cd`,
};
const PROJECT_REPOSITORY = `${OWNED_CHARTS}argoproj.github.io/argo-helm`;

// What is wrong with the owned storage in the three files, as a list of sentences; empty when nothing is.
const problems = ({cluster, platform, slaveProject}) => {
  const found = [];
  const tools = Object.fromEntries(cluster.filter((s) => s.step === 'install_pinned_tool').map((s) => [s.tool, s.url]));
  for (const [tool, url] of Object.entries(TOOL_URLS)) if (tools[tool] !== url) found.push(`${tool} is downloaded from ${tools[tool]}, not ${url}`);
  const repositories = platform.filter((s) => s.step === 'helm_repository').map((s) => s.name);
  if (repositories.join(' ') !== 'hashicorp') found.push(`the helm repositories added are ${repositories.join(', ')}, not hashicorp alone`);
  const releases = Object.fromEntries(platform.filter((s) => s.step === 'helm_release').map((s) => [s.release, s.chart]));
  for (const [release, chart] of Object.entries(RELEASE_CHARTS)) if (releases[release] !== chart) found.push(`the release ${release} names the chart ${releases[release]}, not ${chart}`);
  for (const [release, chart] of Object.entries(releases)) {
    const alias = /^([a-z0-9-]+)\/[a-z0-9-]+$/.exec(chart)?.[1];
    if (alias && !repositories.includes(alias)) found.push(`the release ${release} names ${chart}, and no helm_repository row is named ${alias}`);
  }
  if (!slaveProject.split('\n').some((line) => line.trim() === `- ${PROJECT_REPOSITORY}`)) found.push(`the slave project does not allow ${PROJECT_REPOSITORY}`);
  if (/^\s*- https:\/\/argoproj\.github\.io/m.test(slaveProject)) found.push('the slave project allows the chart repository on GitHub Pages');
  return found;
};

const files = {cluster, platform, slaveProject};
const planted = (change) => { const copy = structuredClone({cluster, platform}); copy.slaveProject = slaveProject; change(copy); return problems(copy); };
const row = (copy, program, predicate) => copy[program].find(predicate);

test('the installer downloads its tools and the charts of its bootstrap releases from the owner\'s mirror', () => {
  assert.deepEqual(problems(files), [], 'PLANTED INNOCENT: the programs and the project template as they stand');
  assert.equal(platform.find((s) => s.step === 'helm_repository').url, 'https://helm.releases.hashicorp.com', 'the hashicorp row stays on its own repository');
});

test('PLANTED DEFECT: a tool back on its GitHub Release asset, a chart back on its repository alias, a helm_repository row on Pages is caught', () => {
  assert.notDeepEqual(planted((c) => { row(c, 'cluster', (s) => s.tool === 'jq').url = 'https://github.com/jqlang/jq/releases/download/<version>/jq-linux-amd64'; }), [], 'jq on GitHub');
  assert.notDeepEqual(planted((c) => { row(c, 'cluster', (s) => s.tool === 'argocd').url = TOOL_URLS.argocd.replace('/blobs/sha256:<sha256>', ''); }), [], 'argocd without the blob of its sha256');
  assert.notDeepEqual(planted((c) => { row(c, 'cluster', (s) => s.tool === 'yq').url = TOOL_URLS.yq.replace('<sha256>', 'a'.repeat(64)); }), [], 'yq with its hex written in the url');
  assert.notDeepEqual(planted((c) => { row(c, 'platform', (s) => s.release === 'idp').chart = 'authentik/authentik'; }), [], 'idp by the alias of a repository that is not added');
  assert.notDeepEqual(planted((c) => { row(c, 'platform', (s) => s.release === 'headlamp').chart = 'headlamp/headlamp'; c.platform.unshift({step: 'helm_repository', name: 'headlamp', url: 'https://kubernetes-sigs.github.io/headlamp/'}); }), [], 'headlamp from its Pages repository');
  assert.notDeepEqual(planted((c) => { c.platform.unshift({step: 'helm_repository', name: 'argo', url: 'https://argoproj.github.io/argo-helm'}); }), [], 'a row that adds the argo repository');
  assert.notDeepEqual(planted((c) => { row(c, 'platform', (s) => s.release === 'argocd').chart = 'argo/argo-cd'; }), [], 'argocd by the alias of a repository that is not added');
  assert.notDeepEqual(planted((c) => { c.slaveProject = slaveProject.replace(PROJECT_REPOSITORY, 'https://argoproj.github.io/argo-helm'); }), [], 'the slave project on GitHub Pages');
  assert.notDeepEqual(planted((c) => { c.platform = c.platform.filter((s) => s.name !== 'hashicorp'); }), [], 'the hashicorp row removed');
});
