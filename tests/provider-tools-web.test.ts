import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it.skipIf(process.env.DSH_TEST_WEB_UI !== '1')('streams a Fireworks-compatible browser turn with Djupleita tools through the model broker', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/provider-tools-web.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 120000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({authenticatedWeb:true,providerSerialization:true,
    streaming:true,toolRoundTrip:true,engagementScopeUnchanged:true});
}, 130000);
