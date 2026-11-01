/** Activate the repository's reviewed local secret checks without replacing custom hooks. */
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { scanner } from './scan.mjs';
const root = resolve(import.meta.dirname, '../..');
scanner();
const existing = spawnSync('git', ['config', '--get', 'core.hooksPath'], { cwd: root, encoding: 'utf8' });
if (existing.stdout.trim() && existing.stdout.trim() !== '.githooks') throw new Error('Custom hooksPath already exists. Add the security scan to that hook before changing it.');
const result = spawnSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: root, stdio: 'inherit' });
if (result.error || result.status !== 0) throw new Error('Cannot enable Git secret checks');
console.log('Enabled staged-secret and outgoing-history checks for this clone.');
