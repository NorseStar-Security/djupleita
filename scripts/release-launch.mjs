/** Entry point for extracted portable distributions; requires no global Node or pnpm. */
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { resolve, join, delimiter } from 'node:path';
const app = resolve(import.meta.dirname, '..');
const directory = resolve(app, '..');
const release = JSON.parse(readFileSync(join(directory, 'release.json'), 'utf8'));
if (release.target !== `${process.platform}-${process.arch}`) throw new Error(`This archive requires ${release.target}; download the archive for ${process.platform}-${process.arch}.`);
const args = process.argv.slice(2);
if (['--version', '-v'].includes(args[0])) {
  console.log(`Djupleita ${release.version} (${release.target}, ${release.commit.slice(0, 12)})`);
} else {
  const command = args[0] === 'setup' ? 'setup-tools.mjs' : 'web.mjs';
  if (args[0] === 'setup' || args[0] === 'web') args.shift();
  const child = spawn(process.execPath, [join(app, 'scripts', command), ...args], { cwd: app, stdio: 'inherit',
    env: { ...process.env, PATH: `${join(directory, 'runtime/bin')}${delimiter}${process.env.PATH ?? ''}` } });
  child.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
  child.on('exit', (code, signal) => { process.exitCode = signal ? 1 : code ?? 1; });
}
