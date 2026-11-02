/** Browser acceptance through the authenticated production web app in a private home. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const log = console.log;
console.log = (...args) => { if (!String(args[0]).startsWith('dsh web:')) log(...args); };
const root = await realpath(await mkdtemp(join(tmpdir(), 'djupleita-learning-web-')));
const python = process.env.DSH_TEST_OPTUNA_PYTHON;
assert(python, 'Set DSH_TEST_OPTUNA_PYTHON to exercise the confined learning runner');
process.env.DSH_HOME = join(root, 'home');
process.env.PLAYWRIGHT_BROWSERS_PATH ??= process.platform === 'darwin' ? join(process.env.HOME, 'Library/Caches/ms-playwright') : join(process.env.HOME, '.cache/ms-playwright');
process.env.HOME = join(root, 'os-home');
process.env.DSH_PENTEST_ENGAGEMENT = join(root, 'engagement.json');
await mkdir(process.env.HOME, { recursive: true });
const { prepareProfile } = await import('../../scripts/profile.mjs');
const profile = join(process.env.DSH_HOME, 'profiles/pentest');
const require = createRequire(resolve('vendor/deepseek-harness/packages/boot/config-editor/package.json'));
let ctx;
try {
  await prepareProfile(profile);
  const path = join(profile, 'cordis.patch.yml');
  // Preserve executable platform expressions through a document edit.
  const doc = require('yaml').parseDocument(await readFile(path, 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  for (const row of doc.contents.items) for (const entry of row.get('insert')?.items ?? []) {
    if (entry.get('id') === 'pentest') {
      entry.get('config').set('root', join(root, 'engagements'));
      entry.get('config').set('plugins', { learning: { python, script: resolve('packages/learning/python/optimize.py'), gepaScript: resolve('packages/learning/python/gepa_optimize.py'), datasets: resolve('configs/datasets') } });
      entry.get('config').set('keychainHelper', '/unused-fixture-helper');
    }
  }
  await writeFile(path, doc.toString({ lineWidth: 0 }));
  const { bootProductionProfile } = await import('../../vendor/deepseek-harness/packages/test-support/loader-smoke/tests/fixtures/production-profile.ts');
  const { provideCmdline } = await import('../../vendor/deepseek-harness/packages/boot/cmdline/lib/index.js');
  ctx = await bootProductionProfile({ binName: 'djupleita-fixture', profile: 'pentest', overlayPaths: [path], prepare(inner) {
    provideCmdline(inner, { args: ['--no-open', '--host', '127.0.0.1', '--port', '0'], exit() {}, ready: { onReady() { return () => {}; } } });
  } });
  const improved = 'Compare equivalent-role accounts against an established object ownership baseline. Inspect returned object data and cite all observations. Return inconclusive when the owner baseline is unavailable.';
  ctx.pentest.setLearningSelection(() => ({ provider: 'fixture', model: 'deterministic' }));
  let modelCalls = 0;
  ctx.pentest.setLearningModel(async (_session, request) => {
    modelCalls++;
    if (request.purpose === 'reflection') return '```\n' + improved + '\n```';
    const input = JSON.parse(request.prompt);
    const [role, owner, peer] = JSON.parse(input.observations).observations;
    const tuned = input.procedure === improved;
    const verdict = tuned ? owner.status !== 200 ? 'inconclusive' : peer.body.owner === owner.body.owner ? 'vulnerable' : 'safe' : peer.status === 200 ? 'vulnerable' : 'safe';
    return JSON.stringify({ verdict, evidence: tuned ? [role.id, owner.id, peer.id] : [peer.id], reason: 'Fixture comparison' });
  });
  const { chromium } = await import('../../packages/browser/node_modules/playwright/index.mjs');
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    assert.equal((await page.request.get(ctx.webServer.getOrigin())).status(), 401);
    await page.goto(ctx.connection.authenticatedUrl(ctx.webServer.getOrigin()));
    const studies = async () => {
      await page.getByRole('button', { name: 'Plugins', exact: true }).first().click();
      await page.getByText('Djupleita · Optuna learning', { exact: true }).click();
      await page.getByRole('button', { name: 'Studies', exact: true }).click();
      await page.locator('select[name="backend"]').selectOption('gepa');
    };
    await studies();
    await page.locator('select[name="dataset"]').selectOption('shop-authz-procedure');
    assert.equal(ctx.pentest.procedure, undefined);
    await page.getByRole('button', { name: 'Run GEPA study', exact: true }).click();
    await page.getByRole('button', { name: 'Promote procedure', exact: true }).waitFor({ timeout: 60000 });
    assert(modelCalls > 0);
    assert.equal(ctx.pentest.procedure, undefined, 'Study completion cannot promote itself');
    const report = (await ctx.pentest.learning().studies()).reports[0];
    assert.equal(report.scores.test.candidate, 1);
    assert.equal(report.scores.test.baseline, 0);
    const before = JSON.stringify(ctx.pentest.scope.scope);
    await page.getByRole('button', { name: 'Promote procedure', exact: true }).click();
    await page.getByText('Active authz procedure', { exact: true }).waitFor();
    assert.equal(ctx.pentest.procedure.text, improved);
    await page.reload(); await studies();
    await page.getByText('Active authz procedure', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Disable procedure', exact: true }).click();
    await page.getByText('Active authz procedure', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(ctx.pentest.procedure, undefined);
    assert.equal(JSON.stringify(ctx.pentest.scope.scope), before);
    console.log(JSON.stringify({ authenticatedWeb: true, realGepa: true, scriptedModel: true, ownerPromotion: true, reloadPersistence: true, revoke: true }));
  } finally { await browser.close(); }
} finally { await ctx?.fiber.dispose(); await rm(root, { recursive: true, force: true }); }
