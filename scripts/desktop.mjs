/** Run the upstream Electron shell with the pentest profile. */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { prepareProfile, upstream, home } from './profile.mjs';

if (process.platform !== 'darwin') throw new Error('The desktop distribution currently targets macOS.');
const prepared = await prepareProfile(join(home, 'profiles/desktop'));
console.log(`Engagement: ${prepared.configPath}`);
const child = spawn('pnpm', ['run', 'start:desktop', ...process.argv.slice(2)], {
  cwd: upstream, stdio: 'inherit', env: {
    ...process.env, DSH_HOME: home, DSH_DESKTOP_OPEN_DEVTOOLS: process.env.DSH_DESKTOP_OPEN_DEVTOOLS ?? '0',
    DSH_DESKTOP_USER_DATA_DIR: join(home, 'electron-user-data'),
  },
});
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { child.kill(signal); });
child.on('exit', code => { process.exitCode = code ?? 1; });
