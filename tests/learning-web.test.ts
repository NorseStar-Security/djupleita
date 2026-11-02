import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it.skipIf(process.env.DSH_TEST_WEB_UI !== '1' || !process.env.DSH_TEST_OPTUNA_PYTHON)('runs real GEPA and owner promotion through the authenticated web interface', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/learning-web.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 90000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ authenticatedWeb: true, realGepa: true, scriptedModel: true, ownerPromotion: true, reloadPersistence: true, revoke: true });
}, 100000);
