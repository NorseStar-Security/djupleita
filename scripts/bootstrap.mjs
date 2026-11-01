import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { applyBranding } from './branding.mjs';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(resolve(root, 'upstream.lock.json'), 'utf8'));
const directory = resolve(root, lock.directory);
function run(args, cwd = root) {
  const result = spawnSync('git', args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
if (!existsSync(directory)) {
  run(['clone', '--no-checkout', '--filter=blob:none', lock.repository, directory]);
  run(['checkout', '--detach', lock.commit], directory);
}
const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' });
if (head.status !== 0 || head.stdout.trim() !== lock.commit) {
  throw new Error(`Upstream must be checked out at ${lock.commit}; existing work was left untouched.`);
}
applyBranding(root);
console.log(`Djupleita: harness ${lock.version} pinned at ${lock.commit}; distribution overlays applied`);
