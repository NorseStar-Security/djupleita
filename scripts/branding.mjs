/** Apply Djupleita's reviewable distribution overlays to the pinned checkout. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export function applyBranding(root) {
  const cwd = resolve(root, 'vendor/deepseek-harness');
  for (const name of ['djupleita-branding.patch', 'djupleita-provider-trust.patch', 'djupleita-replay.patch']) {
    const patch = resolve(root, 'patches', name);
    const check = args => spawnSync('git', ['apply', ...args, patch], { cwd, encoding: 'utf8' });
    if (check(['--reverse', '--check']).status === 0) continue;
    const ready = check(['--check']);
    if (ready.status !== 0) throw new Error(`Djupleita overlay ${name} conflicts with the upstream checkout; existing work was left intact.\n${ready.stderr}`);
    const applied = check([]);
    if (applied.status !== 0) throw new Error(applied.stderr);
  }
}
