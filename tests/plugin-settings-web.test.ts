import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it.skipIf(process.env.DSH_TEST_WEB_UI !== '1')('keeps plugin failures visible and recovers editors through authenticated web UI', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/plugin-settings-web.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 90000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ authenticatedWeb: true, refreshPreservesDraft: true, visibleRenderFailure: true, retryRecovers: true, modeFailureVisible: true, offSurvivesEditorFailure: true, missingModeExplained: true });
}, 100000);
