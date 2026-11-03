import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
it.skipIf(process.env.DSH_TEST_PLUGIN_UI !== '1')('configures native-store plugin keys and dedicated crawl controls through authenticated web UI',()=>{
  const output=execFileSync(process.execPath,['--import',resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'),'tests/fixtures/plugin-controls-web.mjs'],{cwd:resolve('.'),encoding:'utf8',timeout:120000});
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({authenticatedWeb:true,nativeKeys:true,keyRotation:true,noPersistedKeys:true,crawlControls:true,sharedPolicyNavigation:true,localRequestsOnly:true});
},130000);
