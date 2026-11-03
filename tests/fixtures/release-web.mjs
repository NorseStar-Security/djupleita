/** Test the actual extracted artifact. Tokens and runtime logs stay private. */
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from '../../packages/browser/node_modules/playwright/index.mjs';
const directory = resolve(process.argv[2]);
assert.equal(await lstat(join(directory, 'app/.pentest')).then(() => true, () => false), false, 'Use a fresh disposable extraction; existing installation state must remain untouched');
const scratch = await mkdtemp(join(tmpdir(), 'release-web-'));
const home = join(scratch, 'home'); await mkdir(home);
const launcher = join(directory, 'djupleita');
const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'));
assert(execFileSync(launcher, ['--version'], { cwd: scratch, encoding: 'utf8' }).includes(release.version));
const engagement = JSON.parse(await readFile(join(directory, 'app/configs/engagement.example.json'), 'utf8'));
engagement.id = crypto.randomUUID(); engagement.name = 'Release fixture';
engagement.scope = { enabled: false, targets: [{ host: 'app.example.test', schemes: ['https'], ports: [443], pathPrefixes: ['/'], allowPrivateAddresses: false }], exclusions: [], networks: [], services: { model: [], intelligence: [], telemetry: [] } };
const config = join(scratch, 'engagement.json'); await writeFile(config, JSON.stringify(engagement), { mode: 0o600 });
// Set the supported profile option only in this disposable fixture. The real
// first-run download still asks the user to configure a provider.
const overlay = join(directory, 'app/.pentest/home/profiles/pentest/cordis.patch.yml');
await mkdir(join(directory, 'app/.pentest/home/profiles/pentest'), { recursive: true, mode: 0o700 });
await writeFile(overlay, '- id: ui-settings-models\n  config:\n    credentialOnboarding: false\n');
const child = spawn(launcher, [], { cwd: scratch, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, DSH_PENTEST_ENGAGEMENT: config, DSH_PENTEST_PORT: '0', NODE_PATH: '', NODE_OPTIONS: '', PATH: '/usr/bin:/bin' } });
let output = '', browser, page;
child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
try {
  let address;
  for (let i = 0; i < 180; i++) {
    address = output.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+)/)?.[1];
    if (address) break;
    if (child.exitCode !== null) throw new Error('Extracted release exited before authenticated startup');
    await delay(500);
  }
  assert(address, 'Extracted release did not start');
  const origin = new URL(address).origin;
  assert.equal((await fetch(origin)).status, 401);
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  // Never include the token in a Playwright assertion or failure output.
  try { await page.goto(address); } catch { throw new Error('Release authentication failed'); }
  assert.equal(await page.title(), 'Djupleita');
  await page.getByRole('heading', { name: 'Preview Notice', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const later = page.getByRole('button', { name: 'Configure later', exact: true });
  if (await later.waitFor({ state: 'visible', timeout: 3000 }).then(() => true, () => false)) await later.click();
  const policy = async () => {
    await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
    const back = page.getByRole('button', { name: 'Back to plugins', exact: true });
    if (await back.count()) await back.click();
    await page.getByText('Djupleita · Engagement and identities', { exact: true }).click();
  };
  await policy();
  const editor = page.locator('textarea[name="scope"]'); await editor.waitFor();
  assert.deepEqual(JSON.parse(await editor.inputValue()), engagement.scope);
  await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).click();
  await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).waitFor();
  await page.reload(); await policy();
  await page.getByRole('button', { name: 'Turn on engagement layer', exact: true }).click();
  await page.getByRole('button', { name: 'Turn off engagement layer', exact: true }).waitFor();
  console.log(`Extracted ${release.target} release: authenticated browser, saved scope and engagement off/on passed.`);
} catch (error) {
  // Print only startup errors with no token-bearing URLs or local assessment state.
  const safe = output.split('\n').filter(line => /(?:error|failed|invalid|unknown|unsupported|expected|not found)/i.test(line) && !/token=|https?:\/\//.test(line)).slice(-12).join('\n');
  if (safe) console.error(safe);
  const dialogs = await page?.getByRole('dialog').allTextContents().catch(() => []);
  if (dialogs?.length) console.error('Synthetic first-run dialogs:', dialogs.map(text => text.slice(0,600)));
  throw error;
} finally {
  await browser?.close();
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  await Promise.race([new Promise(resolve => child.on('exit', resolve)), delay(3000)]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  await rm(scratch, { recursive: true, force: true });
}
