import { spawn } from 'node:child_process';
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'package.json'));
async function run(command, args) {
  await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolveRun() : reject(new Error(`Build failed (${code})`)));
  });
}
await run(process.execPath, [require.resolve('typescript/bin/tsc'), '-b']);
for (const pkg of await readdir(join(root, 'packages'))) {
  const source = join(root, 'dist/packages', pkg, 'src');
  if (!(await stat(source).catch(() => undefined))?.isDirectory()) continue;
  await mkdir(join(root, 'packages', pkg, 'lib'), { recursive: true });
  await cp(source, join(root, 'packages', pkg, 'lib'), { recursive: true,
    filter: path => !/\.(?:test|spec)\.[cm]?[jt]s(?:x)?(?:\.map)?$/.test(path) });
}
await run(join(root, 'vendor/deepseek-harness/node_modules/.bin/tsdown'), ['--config-loader', 'native', '--config', 'packages/ui/tsdown.config.ts']);
