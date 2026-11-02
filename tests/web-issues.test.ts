import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it.skipIf(process.env.DSH_TEST_WEB_UI !== '1')('uses the authenticated web UI to apply scope, manage destinations, and hide and restore setup', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/web-issues.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 90000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ authenticatedWeb: true,
    courseScopeToggle: true, scopeDraftAndPersistence: true, scopePrefillWithServices: true, destinationManagement: true, setupHideAndRestore: true });
}, 100000);
