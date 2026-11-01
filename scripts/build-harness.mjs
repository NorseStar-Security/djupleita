/** Build the pinned harness with Djupleita's persisted distribution overlays. */
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { applyBranding } from './branding.mjs';

const root = resolve(import.meta.dirname, '..');
applyBranding(root);
for (const script of ['build:artifacts', 'build:check']) {
  await new Promise((resolveBuild, reject) => {
    const child = spawn('pnpm', ['run', script], { cwd: resolve(root, 'vendor/deepseek-harness'),
      env: { ...process.env, DSH_CLIENT_TITLE: 'Djupleita' }, stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', code => code === 0 ? resolveBuild() : reject(new Error(`${script} failed (${code})`)));
  });
}
