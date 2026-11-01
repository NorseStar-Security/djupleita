/** Development preview through DSH's supported profile launcher. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { prepareProfile, root, upstream, home } from './profile.mjs';
const prepared = await prepareProfile();
console.log(`Engagement: ${prepared.configPath}`);
const child = spawn(process.execPath, [join(upstream, 'apps/cli/lib/bin.js'), '--profile', 'pentest', '--no-open', '--host', '127.0.0.1', '--port', process.env.DSH_PENTEST_PORT ?? '0', ...process.argv.slice(2)], {
  cwd: root, stdio: 'inherit', env: { ...process.env, DSH_HOME: home },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', code => { process.exitCode = code ?? 1; });
