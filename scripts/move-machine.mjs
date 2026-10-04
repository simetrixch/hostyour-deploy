import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

const usage = 'usage: move-machine --cloud-dir PATH --books-fqdn HOST --from-domain DOMAIN --to-domain DOMAIN --fqdn HOST --ssh-user USER --dry-run';
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === '--help') {
  process.stdout.write(usage + '\n');
} else {
  try {
    const index = args.indexOf('--cloud-dir');
    if (index < 0 || !args[index + 1] || args[index + 1].startsWith('--') || args.lastIndexOf('--cloud-dir') !== index)
      throw Object.assign(new Error(usage), {code: 64});
    const cloud = resolve(args[index + 1]);
    args.splice(index, 2);
    let planner;
    try { planner = await import(pathToFileURL(resolve(cloud, 'lifecycle/plan-installation-domain.mjs')).href); }
    catch { throw Object.assign(new Error('the Cloud checkout has no usable installation domain planner'), {code: 66}); }
    await planner.runDomainPlan(args, cloud, true);
  } catch (error) {
    process.stderr.write('domain-move: ' + error.message + '\n');
    process.exitCode = Number.isInteger(error.code) ? error.code : 65;
  }
}
