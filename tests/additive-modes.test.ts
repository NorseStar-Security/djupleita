import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

it('boots the shipped profile with additive Standard, Creator and PTC capabilities and invokes native file tools', () => {
  const output = execFileSync(process.execPath, ['--import', resolve('vendor/deepseek-harness/node_modules/tsx/dist/esm/index.mjs'), 'tests/fixtures/additive-modes.mjs'], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 90000,
  });
  expect(JSON.parse(output.trim().split('\n').at(-1)!)).toEqual({ modes: ['pentest', 'standard', 'cordis', 'ptc'], nativeInvocations: true, ptcCatalog: true, baseCatalogsPreserved: true, childCatalogsPreserved: true });
}, 100000);
