import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it.skipIf(process.env.DSH_TEST_WEB_UI !== '1')('replays with or without history and honors the composer model switcher through the authenticated web app', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/replay-web.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 120000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({authenticatedWeb:true,freshHistoryEmpty:true,retainedHistory:true,
    selectedProvider:true,selectedReasoning:true,sourceUnchanged:true,targetRequests:0});
}, 130000);
