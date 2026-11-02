/** Install project-local plugin dependencies. Never runs REA's client setup or scans a target. */
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, access, realpath, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const root = resolve(import.meta.dirname, '..');
const { values } = parseArgs({ options: { only: { type: 'string', default: 'all' }, 'rea-node': { type: 'string' },
  python: { type: 'string' }, ghidra: { type: 'string' }, 'java-home': { type: 'string' }, 'analysis-root': { type: 'string' }, help: { type: 'boolean' } } });
if (values.help) {
  console.log('Usage: pnpm setup:tools [--only recon|ffuf|browser|rea|learning|all]\n\nRecon and ffuf install pinned official macOS/Linux releases and verify archive SHA-256 values.\nBrowser installs Chromium from the pinned Playwright package.\nREA installs its pinned supported Node runtime by default. Optional overrides:\n  --rea-node /absolute/node [--ghidra /absolute/ghidra --java-home /absolute/jdk/Contents/Home]\nLearning: --python /absolute/python3 (defaults to /usr/bin/python3 on Linux, or the prepared desktop Python on macOS).\n\nInstallations stay under .pentest/toolchains. Select Load local setup in Pentest → Plugins afterwards.');
  process.exit(0);
}
if (!['all', 'recon', 'ffuf', 'browser', 'rea', 'learning'].includes(values.only)) throw new Error('--only must be all, recon, ffuf, browser, rea or learning');
async function run(command, args, environment = process.env) {
  await new Promise((done, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: 'inherit', env: environment });
    child.once('error', reject); child.once('exit', code => code === 0 ? done() : reject(new Error(`${command} exited ${code}`)));
  });
}
async function executable(path) { if (!isAbsolute(path)) throw new Error('Use absolute runtime paths'); const actual = await realpath(path); await access(actual, constants.X_OK); return path; }
await mkdir(join(root, '.pentest/toolchains'), { recursive: true, mode: 0o700 });
const configPath = join(root, '.pentest/tooling.json');
const config = JSON.parse(await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error; }));
async function save() { const temporary = `${configPath}.${process.pid}.tmp`; await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 }); await rename(temporary, configPath); }
if (['all', 'recon'].includes(values.only)) {
  const { installReconTools } = await import('../packages/recon/lib/install.js');
  const binaries = await installReconTools(root, AbortSignal.timeout(15 * 60 * 1000));
  config.recon = { ...config.recon, binaries: { ...config.recon?.binaries, ...binaries } };
  await save(); console.log('ProjectDiscovery recon tools installed, verified and configured.');
}
if (['all', 'ffuf'].includes(values.only)) {
  const { installFfuf } = await import('../packages/fuzz/lib/install.js');
  const binary = await installFfuf(root, AbortSignal.timeout(5 * 60 * 1000));
  config.ffuf = { ...config.ffuf, binary };
  await save(); console.log('ffuf installed, verified and configured.');
}
if (['all', 'browser'].includes(values.only)) {
  const directory = join(root, '.pentest/toolchains/browser');
  await run(process.execPath, [join(root, 'packages/browser/node_modules/playwright/cli.js'), 'install', 'chromium'],
    { ...process.env, PLAYWRIGHT_BROWSERS_PATH: directory });
  // Resolve from the pinned Playwright revision, rather than reusing an older
  // directory left by a previous setup. Set this before importing Playwright.
  process.env.PLAYWRIGHT_BROWSERS_PATH = directory;
  const { browserExecutable } = await import('../packages/browser/lib/index.js');
  config.browser = { ...config.browser, headless: true, executable: await executable(browserExecutable({ headless: true })) };
  await save(); console.log('Playwright Chromium configured.');
}
if (['all', 'rea'].includes(values.only)) {
  const { installRea } = await import('../packages/rea/lib/install.js');
  const installed = await installRea(root, AbortSignal.timeout(15 * 60 * 1000), values['rea-node']);
  const analysisRoot = resolve(values['analysis-root'] ?? join(root, '.pentest/analysis'));
  await mkdir(analysisRoot, { recursive: true, mode: 0o700 });
  config.rea = { ...config.rea, ...installed, roots: values['analysis-root'] ? [analysisRoot] : config.rea?.roots ?? [analysisRoot], timeoutMs: config.rea?.timeoutMs ?? 240000,
    ...(values.ghidra ? { ghidra: await realpath(values.ghidra) } : {}), ...(values['java-home'] ? { javaHome: await realpath(values['java-home']) } : {}) };
  await save();
  console.log('REA configured with a supported Node runtime. Archive/DMG inventory is built in; configure Ghidra/JDK for native decompilation.');
}
if (['all', 'learning'].includes(values.only)) {
  const bundled = join(root, 'vendor/deepseek-harness/apps/desktop/.desktop-build/targets', `mac-${process.arch === 'arm64' ? 'arm64' : 'x64'}`, 'runtime/primary-runtime/dependencies/python/bin/python3.12');
  const python = await executable(values.python ?? (process.platform === 'linux' ? '/usr/bin/python3' : bundled)), environment = join(root, '.pentest/toolchains/optuna');
  await run(python, ['-m', 'venv', environment]);
  const pythonEnv = join(environment, 'bin/python');
  await run(pythonEnv, ['-m', 'pip', 'install', '--disable-pip-version-check', '--requirement', join(root, 'packages/learning/python/requirements.txt')]);
  config.learning = { python: pythonEnv, script: join(root, 'packages/learning/python/optimize.py'), datasets: join(root, 'configs/datasets') };
  await save(); console.log('Optuna configured for confined offline studies.');
}
console.log(`Plugin configuration: ${configPath}. Select Load local setup in Pentest → Plugins to use it in this engagement without restarting.`);
